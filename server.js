const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
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

app.post('/voice/incoming', async (req, res) => {
  const from = req.body.From || 'unknown';
  console.log(`📞 Incoming call from: ${from}`);
  
  // Use enhanced TwiML with better handling
  const response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Hello! Thank you for calling 360 Print Works, New Jersey's premier printing company. How can I help you today?</Say>
  <Gather numDigits="1" action="/voice/menu" method="POST" timeout="8" speechTimeout="5">
    <Say voice="Polly.Joanna-Neural">Tell me what you need help with, or press 1 to speak with a representative.</Say>
  </Gather>
</Response>`;
  
  res.type('text/xml');
  res.send(response);
});

app.post('/voice/menu', async (req, res) => {
  const digit = req.body.Digits || '';
  const speechResult = req.body.SpeechResult || '';
  console.log(`🔢 DTMF: ${digit}, Speech: ${speechResult}`);
  
  let response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>`;
  
  // Handle speech input
  if (speechResult && speechResult.length > 2) {
    console.log(`🗣️ User said: ${speechResult}`);
    
    // Get AI response
    try {
      const aiReply = await getAIResponse(speechResult);
      response += `<Say voice="Polly.Joanna-Neural">${aiReply}</Say>`;
    } catch (e) {
      response += `<Say voice="Polly.Joanna-Neural">I can connect you to our team. Please hold.</Say>`;
    }
  }
  
  // Handle digit input
  if (digit === '1' || digit === '2' || digit === '3') {
    response += `<Say voice="Polly.Joanna-Neural">Connecting you to our team now.</Say>`;
    response += `<Dial timeout="30">${FORWARD_TO}</Dial>`;
  } else if (speechResult) {
    // After AI response, give options
    response += `<Gather numDigits="1" action="/voice/menu" method="POST" timeout="8">
      <Say voice="Polly.Joanna-Neural">Press 1 to speak with someone, or tell me more.</Say>
    </Gather>`;
  } else {
    response += `<Say voice="Polly.Joanna-Neural">No problem. Press 1 to speak with our team.</Say>`;
    response += `<Dial>${FORWARD_TO}</Dial>`;
  }
  
  response += `</Response>`;
  res.type('text/xml');
  res.send(response);
});

// ============ AI Chat ============

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
    // Keep response short for voice
    if (reply.length > 200) {
      reply = reply.substring(0, 200);
    }
    return reply;
  } catch (error) {
    console.error('AI Error:', error.message);
    return "I'd be happy to help you. Press 1 to speak with our team.";
  }
}

app.post('/ai/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  
  const reply = await getAIResponse(message);
  res.json({ reply });
});

// ============ Status ============

app.get('/health', (req, res) => {
  res.json({ status: 'ok', type: 'voice with speech recognition' });
});

app.get('/', (req, res) => {
  res.json({ 
    service: 'MiniMax Voice Agent',
    features: ['AI greeting', 'Speech recognition', 'Call forwarding']
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎙️ Voice agent running on port ${PORT}`));
