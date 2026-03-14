const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { WebSocketServer } = require('ws');
const http = require('http');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const HOST = process.env.RENDER_EXTERNAL_URL || 'https://mini-max-voice-agent.onrender.com';

const deepgram = createClient(DEEPGRAM_API_KEY);

// MiniMax API instance
const minimaxApi = axios.create({
  baseURL: 'https://api.minimax.io/v1',
  headers: { 'Authorization': `Bearer ${MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
  timeout: 8000,
});

// Short persona for fast responses
const PERSONA = `You are a friendly receptionist for 360 Print Works, a printing company in New Jersey.
Be very brief - 1-2 sentences max. Helpful and friendly. No asterisks or action text.`;

const conversationHistory = new Map();
const activeCalls = new Map();

// ============ KNOWLEDGE BASE ============
const KNOWLEDGE_BASE = {
  'business cards': 'Business cards starting at $19.99 for 500.',
  'brochures': 'Brochures start at $49.99 for 1000 copies.',
  'flyers': 'Flyers start at $29.99 for 500 copies.',
  'posters': 'Posters start at $24.99 each. Up to 24x36 inches.',
  'banners': 'Vinyl banners start at $45.00.',
  'price': 'Business cards $19.99, flyers $29.99, brochures $49.99.',
  'quote': 'What product and quantity do you need?',
  'discount': '10% off orders over $200, 15% off over $500.',
  'hours': 'Open Monday through Friday, 8am to 6pm.',
  'location': 'We are located in New Jersey.',
};

function searchKnowledgeBase(query) {
  const lower = query.toLowerCase();
  for (const [kw, answer] of Object.entries(KNOWLEDGE_BASE)) {
    if (lower.includes(kw)) return answer;
  }
  return null;
}

// ============ AI FUNCTION ============
async function getAIResponse(message, phoneNumber = 'default') {
  const kbAnswer = searchKnowledgeBase(message);
  if (kbAnswer) return kbAnswer;
  try {
    const history = conversationHistory.get(phoneNumber) || [];
    const recentHistory = history.slice(-6);
    const messages = [
      { role: 'system', content: PERSONA },
      ...recentHistory,
      { role: 'user', content: message }
    ];
    const response = await minimaxApi.post('/chat/completions', {
      model: 'M2-her',
      messages,
      max_tokens: 50,
    });
    let reply = response.data.choices[0].message.content;
    if (reply.length > 150) reply = reply.substring(0, 150);
    reply = reply.replace(/\*[^*]+\*/g, '').trim();
    const hist = conversationHistory.get(phoneNumber) || [];
    hist.push({ role: 'user', content: message });
    hist.push({ role: 'assistant', content: reply });
    if (hist.length > 6) hist.splice(0, 2);
    conversationHistory.set(phoneNumber, hist);
    return reply;
  } catch (error) {
    console.error('AI Error:', error.message);
    return "Sure, how can I help you?";
  }
}

// ============ DEEPGRAM TTS -> MULAW AUDIO ============
async function textToSpeechMulaw(text) {
  try {
    const response = await axios({
      method: 'POST',
      url: 'https://api.deepgram.com/v1/speak?model=aura-2-theia-en&encoding=mulaw&sample_rate=8000&container=none',
      headers: {
        'Authorization': `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ text }),
      responseType: 'arraybuffer',
      timeout: 5000,
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.error('TTS Error:', error.message);
    return null;
  }
}

// ============ SEND AUDIO BACK VIA TWILIO WS ============
function sendAudioToTwilio(twilioWs, streamSid, audioBuffer) {
  if (!audioBuffer || !streamSid) return;
  // Send in 160-byte chunks (20ms of mulaw at 8kHz)
  const CHUNK_SIZE = 160;
  for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
    const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);
    const msg = JSON.stringify({
      event: 'media',
      streamSid: streamSid,
      media: { payload: chunk.toString('base64') }
    });
    if (twilioWs.readyState === 1) {
      twilioWs.send(msg);
    }
  }
  // Send mark to know when audio finishes
  if (twilioWs.readyState === 1) {
    twilioWs.send(JSON.stringify({
      event: 'mark',
      streamSid: streamSid,
      mark: { name: 'audio_done' }
    }));
  }
}

// ============ HTTP SERVER ============
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

// ============ VOICE ROUTES ============
app.post('/voice/incoming', (req, res) => {
  const from = req.body.From || 'unknown';
  console.log('Call from:', from);
  const wsHost = HOST.replace('https://', '');
  // Use Connect + Stream for bidirectional audio
  const response = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${wsHost}/stream"><Parameter name="greeting" value="true" /></Stream></Connect></Response>`;
  res.type('text/xml');
  res.send(response);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeCalls: activeCalls.size });
});

app.get('/', (req, res) => {
  res.json({ service: 'Voice Agent - Bidirectional', version: '3.0' });
});

// ============ WEBSOCKET: BIDIRECTIONAL STREAMING ============
wss.on('connection', (twilioWs) => {
  console.log('Twilio Media Stream connected');
  let callSid = null;
  let streamSid = null;
  let dgConnection = null;
  let transcriptBuffer = '';
  let isProcessing = false;
  let isSpeaking = false;

  // Send greeting audio when stream starts
  async function sendGreeting() {
    const greetingText = 'Hello! Thank you for calling 360 Print Works. How may I help you today?';
    console.log('Sending greeting via TTS');
    const audio = await textToSpeechMulaw(greetingText);
    if (audio) {
      sendAudioToTwilio(twilioWs, streamSid, audio);
      console.log('Greeting audio sent');
    }
  }

  // Connect to Deepgram STT
  function connectDeepgram() {
    dgConnection = deepgram.listen.live({
      model: 'nova-3',
      language: 'en-US',
      smart_format: false,
      encoding: 'mulaw',
      sample_rate: 8000,
      channels: 1,
      interim_results: true,
      utterance_end_ms: 1000,
      vad_events: true,
      endpointing: 300,
    });

    dgConnection.on(LiveTranscriptionEvents.Open, () => {
      console.log('Deepgram connected');
    });

    dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (!transcript || transcript.trim() === '') return;
      if (data.is_final) {
        transcriptBuffer += ' ' + transcript;
        console.log('STT:', transcript);
        // If AI is speaking and user talks, clear the audio (barge-in)
        if (isSpeaking && streamSid && twilioWs.readyState === 1) {
          twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
          isSpeaking = false;
          console.log('Barge-in: cleared audio');
        }
      }
    });

    dgConnection.on(LiveTranscriptionEvents.UtteranceEnd, async () => {
      const fullText = transcriptBuffer.trim();
      if (!fullText || isProcessing) return;
      console.log('User said:', fullText);
      transcriptBuffer = '';
      isProcessing = true;
      const startTime = Date.now();
      try {
        // Get AI response
        const aiReply = await getAIResponse(fullText, callSid || 'unknown');
        const aiTime = Date.now() - startTime;
        console.log(`AI reply (${aiTime}ms):`, aiReply);
        // Convert to audio and send back through websocket
        const audio = await textToSpeechMulaw(aiReply);
        const totalTime = Date.now() - startTime;
        if (audio && streamSid) {
          isSpeaking = true;
          sendAudioToTwilio(twilioWs, streamSid, audio);
          console.log(`Total response time: ${totalTime}ms (AI: ${aiTime}ms, TTS: ${totalTime - aiTime}ms)`);
        }
      } catch (err) {
        console.error('Error:', err.message);
      } finally {
        isProcessing = false;
      }
    });

    dgConnection.on(LiveTranscriptionEvents.Error, (error) => {
      console.error('Deepgram error:', error);
    });

    dgConnection.on(LiveTranscriptionEvents.Close, () => {
      console.log('Deepgram closed');
    });

    const keepAlive = setInterval(() => {
      if (dgConnection) dgConnection.keepAlive();
    }, 8000);
    dgConnection._keepAliveInterval = keepAlive;
  }

  connectDeepgram();

  twilioWs.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      switch (data.event) {
        case 'start':
          callSid = data.start.callSid;
          streamSid = data.start.streamSid;
          console.log('Stream started - Call:', callSid);
          activeCalls.set(callSid, { streamSid, startTime: Date.now() });
          // Send greeting after stream starts
          sendGreeting();
          break;
        case 'media':
          if (dgConnection && dgConnection.getReadyState() === 1) {
            dgConnection.send(Buffer.from(data.media.payload, 'base64'));
          }
          break;
        case 'mark':
          if (data.mark?.name === 'audio_done') {
            isSpeaking = false;
          }
          break;
        case 'stop':
          console.log('Stream stopped');
          if (callSid) activeCalls.delete(callSid);
          break;
      }
    } catch (err) {
      console.error('Parse error:', err.message);
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio WS closed');
    if (dgConnection) {
      clearInterval(dgConnection._keepAliveInterval);
      dgConnection.requestClose();
    }
    if (callSid) activeCalls.delete(callSid);
  });

  twilioWs.on('error', (err) => {
    console.error('WS error:', err.message);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Voice Agent v3 ready on port ${PORT}`));
