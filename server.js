const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { WebSocketServer } = require('ws');
const http = require('http');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const FORWARD_TO = process.env.FORWARD_TO || '+18089139158';
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// AI Persona
const PERSONA = `You are a friendly receptionist for 360 Print Works, a printing company in New Jersey.
Be very brief - 1-2 sentences max. Helpful and friendly.`;

// ============ HTTP SERVER ============

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

// ============ VOICE ROUTES ============

app.post('/voice/incoming', (req, res) => {
  const from = req.body.From || 'unknown';
  console.log(`📞 Call from: ${from}`);
  
  // Connect to voice agent for 2-way conversation via Twilio Media Streams
  const response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://mini-max-voice-agent.onrender.com/stream" />
  </Connect>
</Response>`;
  
  res.type('text/xml');
  res.send(response);
});

// Fallback menu
app.post('/voice/menu', async (req, res) => {
  const digit = req.body.Digits || '';
  
  let response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>`;
  
  if (digit === '1') {
    response += `<Dial>${FORWARD_TO}</Dial>`;
  } else if (digit === '2') {
    response += `<Dial>${FORWARD_TO}</Dial>`;
  } else if (digit === '3') {
    response += `<Say>We're at 85 May Street, Irvington, New Jersey.</Say>`;
  }
  
  response += `</Response>`;
  res.type('text/xml');
  res.send(response);
});

// ============ WEBSOCKET FOR REAL-TIME SPEECH (DEEPGRAM) ============

wss.on('connection', (ws) => {
  console.log('🔗 WebSocket connected');
  
  let dgSocket = null;
  let streamSid = null;
  
  // Connect to Deepgram
  try {
    dgSocket = new WebSocket(
      'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&interim_results=true',
      {
        headers: {
          'Authorization': `Token ${DEEPGRAM_API_KEY}`
        }
      }
    );
    
    dgSocket.on('open', () => {
      console.log('✅ Connected to Deepgram');
    });
    
    dgSocket.on('message', async (msg) => {
      const data = JSON.parse(msg);
      const transcript = data.channel?.alternatives[0]?.transcript;
      
      if (transcript && data.is_final) {
        console.log(`🗣️ Heard: ${transcript}`);
        
        // Get AI response
        const reply = await getAIResponse(transcript);
        console.log(`🤖 AI: ${reply}`);
        
        // Convert to speech using MiniMax TTS
        const audio = await getTTS(reply);
        
        if (audio) {
          // Would send back via Twilio - simplified for now
          console.log(`📢 Speaking: ${reply}`);
        }
      }
    });
    
    dgSocket.on('error', (err) => {
      console.error('Deepgram error:', err);
    });
  } catch (err) {
    console.error('Failed to connect to Deepgram:', err.message);
  }
  
  // Handle Twilio media stream
  ws.on('message', (msg) => {
    const data = JSON.parse(msg);
    
    if (data.event === 'media') {
      // Forward audio to Deepgram
      if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
        const audio = Buffer.from(data.media.payload, 'base64');
        dgSocket.send(audio);
      }
    } else if (data.event === 'start') {
      streamSid = data.streamSid;
      console.log('📻 Stream started:', streamSid);
    } else if (data.event === 'stop') {
      console.log('📻 Stream stopped');
      if (dgSocket) dgSocket.close();
    }
  });
  
  ws.on('close', () => {
    console.log('❌ WebSocket closed');
    if (dgSocket) dgSocket.close();
  });
});

// ============ AI FUNCTIONS ============

async function getAIResponse(message) {
  try {
    const response = await axios.post(
      'https://api.minimax.io/v1/chat/completions',
      {
        model: 'M2-her',
        messages: [
          { role: 'system', content: PERSONA },
          { role: 'user', content: message }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${MINIMAX_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    let reply = response.data.choices[0].message.content;
    if (reply.length > 150) reply = reply.substring(0, 150);
    return reply;
  } catch (error) {
    console.error('AI Error:', error.message);
    return "I'd be happy to help. Can you tell me more?";
  }
}

async function getTTS(text) {
  // MiniMax TTS would go here
  // For now, returning null to use Twilio's TTS fallback
  return null;
}

// ============ STATUS ============

app.post('/ai/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  
  const reply = await getAIResponse(message);
  res.json({ reply });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', type: '2-way with Deepgram' });
});

app.get('/', (req, res) => {
  res.json({ service: 'MiniMax + Deepgram Voice' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎙️ 2-Way Voice on port ${PORT}`));
