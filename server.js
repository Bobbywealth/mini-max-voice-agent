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
  
  // Connect to our WebSocket for 2-way audio
  const response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Hello! Thank you for calling 360 Print Works. How may I help you today?</Say>
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
  } else {
    response += `<Dial>${FORWARD_TO}</Dial>`;
  }
  
  response += `</Response>`;
  res.type('text/xml');
  res.send(response);
});

// ============ WEBSOCKET FOR REAL-TIME AUDIO ============

wss.on('connection', (ws) => {
  console.log('🔗 WebSocket connected');
  
  let dgSocket = null;
  let streamSid = null;
  
  // Connect to Deepgram for speech-to-text
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
      console.log('✅ Deepgram connected');
    });
    
    dgSocket.on('message', async (msg) => {
      const data = JSON.parse(msg);
      const transcript = data.channel?.alternatives[0]?.transcript;
      
      if (transcript && data.is_final && transcript.length > 2) {
        console.log(`🗣️ Heard: ${transcript}`);
        
        // Get AI response
        const reply = await getAIResponse(transcript);
        console.log(`🤖 AI: ${reply}`);
        
        // Use streaming TTS for lower latency
        await streamTTS(reply, ws);
        console.log(`📢 Playing: ${reply}`);
      }
    });
    
    dgSocket.on('error', (err) => {
      console.error('Deepgram error:', err.message);
    });
  } catch (err) {
    console.error('Failed to connect Deepgram:', err.message);
  }
  
  // Forward Twilio audio to Deepgram
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      
      if (data.event === 'media') {
        const audio = Buffer.from(data.media.payload, 'base64');
        if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
          dgSocket.send(audio);
        }
      } else if (data.event === 'start') {
        streamSid = data.streamSid;
        console.log('📻 Stream started:', streamSid);
      } else if (data.event === 'stop') {
        console.log('📻 Stream stopped');
        if (dgSocket) dgSocket.close();
      }
    } catch (e) {
      console.error('WS message error:', e.message);
    }
  });
  
  ws.on('close', () => {
    console.log('❌ WebSocket closed');
    if (dgSocket) dgSocket.close();
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
    
    let reply = response.data.choices[0].message.content;
    if (reply.length > 150) reply = reply.substring(0, 150);
    return reply;
  } catch (error) {
    console.error('AI Error:', error.message);
    return "I'd be happy to help you with that.";
  }
}

// Streaming TTS - sends chunks as they arrive for lower latency
async function streamTTS(text, ws) {
  try {
    const response = await axios.post(
      'https://api.minimax.io/v1/t2a',
      {
        text: text,
        voice_id: 'English_Upbeat_Woman',
        model: 'speech-01-turbo',
        speed: 1.1,
        stream: true
      },
      {
        headers: {
          'Authorization': `Bearer ${MINIMAX_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: 'stream'
      }
    );

    return new Promise((resolve, reject) => {
      let audioBuffer = Buffer.alloc(0);
      
      response.data.on('data', (chunk) => {
        audioBuffer = Buffer.concat([audioBuffer, chunk]);
        
        // Send chunks to Twilio as they arrive (in base64)
        const chunkBase64 = chunk.toString('base64');
        if (chunkBase64.length > 0) {
          ws.send(JSON.stringify({
            event: 'media',
            media: {
              payload: chunkBase64
            }
          }));
        }
      });
      
      response.data.on('end', () => {
        console.log(`📢 Streaming complete: ${text}`);
        resolve(audioBuffer.toString('base64'));
      });
      
      response.data.on('error', (err) => {
        console.error('TTS Stream error:', err.message);
        reject(err);
      });
    });
  } catch (error) {
    console.error('TTS Error:', error.message);
    return null;
  }
}

// Original getTTS (kept for compatibility)
async function getTTS(text) {
  try {
    const response = await axios.post(
      'https://api.minimax.io/v1/t2a',
      {
        text: text,
        voice_id: 'English_Upbeat_Woman',
        model: 'speech-01-turbo',
        speed: 1.1,
        vol: 1.0
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

// ============ STATUS ============

app.post('/ai/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  
  const reply = await getAIResponse(message);
  res.json({ reply });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', type: '2-way with Deepgram + MiniMax TTS' });
});

app.get('/', (req, res) => {
  res.json({ service: '2-Way Voice Agent' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎙️ 2-Way Voice on port ${PORT}`));
