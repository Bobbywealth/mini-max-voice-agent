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
const HOST = process.env.RENDER_EXTERNAL_URL || 'https://mini-max-voice-agent.onrender.com';

const deepgram = createClient(DEEPGRAM_API_KEY);

const minimaxApi = axios.create({
  baseURL: 'https://api.minimax.io/v1',
  headers: { 'Authorization': `Bearer ${MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
  timeout: 8000,
});

// STRICT: max 15 words, one sentence only
const PERSONA = `You are a receptionist for 360 Print Works in New Jersey.
REPLY IN ONE SHORT SENTENCE ONLY. Maximum 12 words. Never use asterisks.`;

const conversationHistory = new Map();
const activeCalls = new Map();

const KNOWLEDGE_BASE = {
  'business card': 'Business cards start at $19.99 for 500.',
  'brochure': 'Brochures start at $49.99 for 1000.',
  'flyer': 'Flyers start at $29.99 for 500.',
  'poster': 'Posters start at $24.99 each.',
  'banner': 'Vinyl banners start at $45.',
  'price': 'Cards $19.99, flyers $29.99, brochures $49.99.',
  'quote': 'What product and quantity do you need?',
  'discount': '10% off over $200, 15% off over $500.',
  'hour': 'Open Monday through Friday, 8am to 6pm.',
  'location': 'We are located in New Jersey.',
  'get started': 'Tell me what you need to print and I can give you a price.',
  'hello': 'Hi! What can I help you print today?',
  'hi': 'Hi! What can I help you print today?',
};

function searchKnowledgeBase(query) {
  const lower = query.toLowerCase();
  for (const [kw, answer] of Object.entries(KNOWLEDGE_BASE)) {
    if (lower.includes(kw)) return answer;
  }
  return null;
}

async function getAIResponse(message, phoneNumber = 'default') {
  const kbAnswer = searchKnowledgeBase(message);
  if (kbAnswer) return kbAnswer;
  try {
    const history = conversationHistory.get(phoneNumber) || [];
    const recentHistory = history.slice(-4);
    const messages = [
      { role: 'system', content: PERSONA },
      ...recentHistory,
      { role: 'user', content: message }
    ];
    const response = await minimaxApi.post('/chat/completions', {
      model: 'M2-her',
      messages,
      max_tokens: 30,
    });
    let reply = response.data.choices[0].message.content;
    // Hard truncate at first sentence or 80 chars
    const sentenceEnd = reply.search(/[.!?]/);
    if (sentenceEnd > 0) reply = reply.substring(0, sentenceEnd + 1);
    if (reply.length > 80) reply = reply.substring(0, 80);
    reply = reply.replace(/\*[^*]+\*/g, '').trim();
    const hist = conversationHistory.get(phoneNumber) || [];
    hist.push({ role: 'user', content: message });
    hist.push({ role: 'assistant', content: reply });
    if (hist.length > 4) hist.splice(0, 2);
    conversationHistory.set(phoneNumber, hist);
    return reply;
  } catch (error) {
    console.error('AI Error:', error.message);
    return 'How can I help you today?';
  }
}

// Streaming TTS: sends audio chunks as they arrive
async function streamTTSToTwilio(text, twilioWs, streamSid) {
  return new Promise((resolve) => {
    const url = 'https://api.deepgram.com/v1/speak?model=aura-2-andromeda-en&encoding=mulaw&sample_rate=8000&container=none';
    const https = require('https');
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Authorization': `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify({ text })),
      },
    };
    const req = https.request(options, (res) => {
      let chunkBuffer = Buffer.alloc(0);
      const CHUNK_SIZE = 3200; // 400ms of audio per send
      res.on('data', (chunk) => {
        chunkBuffer = Buffer.concat([chunkBuffer, chunk]);
        // Send in CHUNK_SIZE pieces as they arrive
        while (chunkBuffer.length >= CHUNK_SIZE) {
          const toSend = chunkBuffer.slice(0, CHUNK_SIZE);
          chunkBuffer = chunkBuffer.slice(CHUNK_SIZE);
          if (twilioWs.readyState === 1) {
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: toSend.toString('base64') }
            }));
          }
        }
      });
      res.on('end', () => {
        // Send remaining audio
        if (chunkBuffer.length > 0 && twilioWs.readyState === 1) {
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: chunkBuffer.toString('base64') }
          }));
        }
        if (twilioWs.readyState === 1) {
          twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'audio_done' } }));
        }
        resolve();
      });
      res.on('error', (err) => {
        console.error('TTS stream error:', err.message);
        resolve();
      });
    });
    req.on('error', (err) => {
      console.error('TTS request error:', err.message);
      resolve();
    });
    req.write(JSON.stringify({ text }));
    req.end();
  });
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

app.post('/voice/incoming', (req, res) => {
  const from = req.body.From || 'unknown';
  console.log('Call from:', from);
  const wsHost = HOST.replace('https://', '');
  const response = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${wsHost}/stream" /></Connect></Response>`;
  res.type('text/xml');
  res.send(response);
});

app.get('/health', (req, res) => res.json({ status: 'ok', activeCalls: activeCalls.size }));
app.get('/', (req, res) => res.json({ service: 'Voice Agent v4 - Streaming TTS', version: '4.0' }));

wss.on('connection', (twilioWs) => {
  console.log('Twilio Media Stream connected');
  let callSid = null;
  let streamSid = null;
  let dgConnection = null;
  let transcriptBuffer = '';
  let isProcessing = false;
  let isSpeaking = false;

  async function sendGreeting() {
    const text = 'Thanks for calling 360 Print Works. How can I help you?';
    console.log('Sending greeting');
    isSpeaking = true;
    await streamTTSToTwilio(text, twilioWs, streamSid);
    console.log('Greeting sent');
  }

  function connectDeepgram() {
    dgConnection = deepgram.listen.live({
      model: 'nova-3',
      language: 'en-US',
      smart_format: false,
      encoding: 'mulaw',
      sample_rate: 8000,
      channels: 1,
      interim_results: true,
      utterance_end_ms: 800,
      vad_events: true,
      endpointing: 200,
    });

    dgConnection.on(LiveTranscriptionEvents.Open, () => console.log('Deepgram connected'));

    dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (!transcript || transcript.trim() === '') return;
      if (data.is_final) {
        transcriptBuffer += ' ' + transcript;
        console.log('STT:', transcript);
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
        const aiReply = await getAIResponse(fullText, callSid || 'unknown');
        const aiTime = Date.now() - startTime;
        console.log(`AI reply (${aiTime}ms):`, aiReply);
        if (streamSid) {
          isSpeaking = true;
          await streamTTSToTwilio(aiReply, twilioWs, streamSid);
          console.log(`Total response time: ${Date.now() - startTime}ms (AI: ${aiTime}ms)`);
        }
      } catch (err) {
        console.error('Error:', err.message);
      } finally {
        isProcessing = false;
        isSpeaking = false;
      }
    });

    dgConnection.on(LiveTranscriptionEvents.Error, (e) => console.error('Deepgram error:', e));
    dgConnection.on(LiveTranscriptionEvents.Close, () => console.log('Deepgram closed'));

    const keepAlive = setInterval(() => { if (dgConnection) dgConnection.keepAlive(); }, 8000);
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
          sendGreeting();
          break;
        case 'media':
          if (dgConnection && dgConnection.getReadyState() === 1) {
            dgConnection.send(Buffer.from(data.media.payload, 'base64'));
          }
          break;
        case 'mark':
          if (data.mark?.name === 'audio_done') isSpeaking = false;
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

  twilioWs.on('error', (err) => console.error('WS error:', err.message));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Voice Agent v4 ready on port ${PORT}`));
