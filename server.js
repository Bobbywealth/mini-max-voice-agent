const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { WebSocketServer } = require('ws');
const http = require('http');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const FORWARD_TO = process.env.FORWARD_TO || '+18089139158';
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const HOST = process.env.RENDER_EXTERNAL_URL || 'https://mini-max-voice-agent.onrender.com';

// Pre-create Deepgram client once
const deepgram = createClient(DEEPGRAM_API_KEY);

// Pre-create axios instance with keep-alive for Twilio API
const twilioApi = axios.create({
  baseURL: `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}`,
  auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  timeout: 5000,
});

// Pre-create axios instance for MiniMax with timeout
const minimaxApi = axios.create({
  baseURL: 'https://api.minimax.io/v1',
  headers: { 'Authorization': `Bearer ${MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
  timeout: 8000,
});

// AI Persona - keep short to reduce token processing
const PERSONA = `You are a friendly receptionist for 360 Print Works, a printing company in New Jersey.
Be very brief - 1-2 sentences max. Helpful and friendly. No asterisks or action text.`;

// Conversation history store
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

// ============ AI FUNCTION (optimized) ============
async function getAIResponse(message, phoneNumber = 'default') {
  const kbAnswer = searchKnowledgeBase(message);
  if (kbAnswer) return kbAnswer; // Fast path: skip AI if KB has answer

  try {
    const history = conversationHistory.get(phoneNumber) || [];
    // Only send last 3 exchanges to reduce tokens
    const recentHistory = history.slice(-6);
    const messages = [
      { role: 'system', content: PERSONA },
      ...recentHistory,
      { role: 'user', content: message }
    ];

    const response = await minimaxApi.post('/chat/completions', {
      model: 'M2-her',
      messages,
      max_tokens: 80,
    });

    let reply = response.data.choices[0].message.content;
    if (reply.length > 150) reply = reply.substring(0, 150);
    reply = reply.replace(/\*[^*]+\*/g, '').trim();

    // Save history
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

// ============ TWILIO CALL UPDATE (optimized) ============
async function updateCallWithResponse(callSid, aiResponse) {
  const wsHost = HOST.replace('https://', '');
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">${aiResponse}</Say><Connect><Stream url="wss://${wsHost}/stream" /></Connect></Response>`;

  try {
    await twilioApi.post(`/Calls/${callSid}.json`,
      new URLSearchParams({ Twiml: twiml }).toString()
    );
    console.log('Call updated with AI response');
  } catch (error) {
    console.error('Failed to update call:', error.message);
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
  const response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Hello! Thank you for calling 360 Print Works. How may I help you today?</Say>
  <Connect>
    <Stream url="wss://${wsHost}/stream" />
  </Connect>
</Response>`;

  res.type('text/xml');
  res.send(response);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeCalls: activeCalls.size });
});

app.get('/', (req, res) => {
  res.json({ service: 'Voice Agent - Low Latency', version: '2.0' });
});

// ============ WEBSOCKET: TWILIO STREAM -> DEEPGRAM STT ============
wss.on('connection', (twilioWs) => {
  console.log('Twilio Media Stream connected');

  let callSid = null;
  let streamSid = null;
  let dgConnection = null;
  let transcriptBuffer = '';
  let isProcessing = false;
  let lastTranscriptTime = 0;

  // Connect to Deepgram live STT with low-latency settings
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
        lastTranscriptTime = Date.now();
        console.log('STT:', transcript);
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
        console.log(`AI reply (${Date.now() - startTime}ms):`, aiReply);

        if (callSid) {
          await updateCallWithResponse(callSid, aiReply);
          console.log(`Total response time: ${Date.now() - startTime}ms`);
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

    // Keep alive every 8s
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
          break;
        case 'media':
          if (dgConnection && dgConnection.getReadyState() === 1) {
            dgConnection.send(Buffer.from(data.media.payload, 'base64'));
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
server.listen(PORT, () => console.log(`Voice Agent ready on port ${PORT}`));
