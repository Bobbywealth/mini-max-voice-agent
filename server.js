const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Transform } = require('stream');
const { WebSocketServer } = require('ws');
const http = require('http');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const FORWARD_TO = process.env.FORWARD_TO || '+18089139158';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;

// MiniMax AI Persona
const PERSONA = `You are a friendly receptionist for 360 Print Works, a printing company in New Jersey. 
You help customers with:
- Getting quotes for printing services (business cards, brochures, banners, etc)
- Understanding services offered
- Checking order status
- Scheduling appointments
Be friendly, professional, and concise. Keep responses short for voice conversation.`;

// ============ VOICE ROUTES ============

app.post('/voice/incoming', (req, res) => {
  const from = req.body.From || 'unknown';
  console.log(`📞 Incoming call from: ${from}`);
  
  // Start Twilio Media Stream for 2-way conversation
  const response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host.replace(':3000','')}/stream" />
  </Connect>
  <Say voice="Polly.Joanna-Neural">Hello! Thank you for calling 360 Print Works. How can I help you today?</Say>
</Response>`;
  
  res.type('text/xml');
  res.send(response);
});

// WebSocket for real-time audio streaming (Deepgram)
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws) => {
  console.log('🔗 WebSocket connected');
  let deepgram = null;
  let streamSid = null;
  
  // Connect to Deepgram
  const dgSocket = new WebSocket(
    'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1',
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
    
    if (transcript && transcript.length > 0) {
      console.log(`🗣️ You said: ${transcript}`);
      
      // Get AI response
      const reply = await getAIResponse(transcript);
      console.log(`🤖 AI: ${reply}`);
      
      // Convert to speech using MiniMax TTS
      const audioBase64 = await getTTS(reply);
      
      // Send audio back via Twilio Media Stream (would need proper implementation)
      ws.send(JSON.stringify({
        event: 'media',
        media: {
          payload: audioBase64
        }
      }));
    }
  });
  
  dgSocket.on('error', (err) => {
    console.error('Deepgram error:', err);
  });
  
  // Forward audio to Deepgram
  ws.on('message', (msg) => {
    const data = JSON.parse(msg);
    
    if (data.event === 'media') {
      const audio = Buffer.from(data.media.payload, 'base64');
      dgSocket.send(audio);
    } else if (data.event === 'start') {
      streamSid = data.streamSid;
      console.log('📻 Stream started:', streamSid);
    } else if (data.event === 'stop') {
      console.log('📻 Stream stopped');
      dgSocket.close();
    }
  });
  
  ws.on('close', () => {
    console.log('❌ WebSocket closed');
    dgSocket.close();
  });
});

// ============ AI & TTS ============

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
    
    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('AI Error:', error.message);
    return "I'm here to help! How can I assist you today?";
  }
}

async function getTTS(text) {
  try {
    // Using MiniMax TTS
    const response = await axios.post(
      'https://api.minimax.io/v1/t2a',
      {
        text: text,
        voice_id: 'male-shaun-2',
        model: 'speech-01-turbo'
      },
      {
        headers: {
          'Authorization': `Bearer ${MINIMAX_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer'
      }
    );
    
    return Buffer.from(response.data).toString('base64');
  } catch (error) {
    console.error('TTS Error:', error.message);
    return null;
  }
}

// ============ FALLBACK ROUTES ============

app.post('/voice/menu', (req, res) => {
  const digit = req.body.Digits || '';
  let response = `<?xml version="1.0" encoding="UTF-8"?><Response>`;
  
  if (digit) {
    response += `<Dial>${FORWARD_TO}</Dial>`;
  }
  
  response += `</Response>`;
  res.type('text/xml');
  res.send(response);
});

app.post('/ai/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  
  const reply = await getAIResponse(message);
  res.json({ reply });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', type: '2-way voice with Deepgram' });
});

app.get('/', (req, res) => {
  res.json({ service: 'MiniMax 2-Way Voice Agent', status: 'running' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎙️ 2-Way Voice Agent running on port ${PORT}`));
