const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const FORWARD_TO = process.env.FORWARD_TO || '+18089139158';

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
  
  const response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Hello! Thank you for calling 360 Print Works, New Jersey's premier printing company. How may I help you today?</Say>
  <Gather numDigits="1" action="/voice/menu" method="POST" timeout="10">
    <Say voice="Polly.Joanna-Neural">Press 1 to get a free quote. Press 2 to check your order status. Press 3 to speak with a representative.</Say>
  </Gather>
</Response>`;
  
  res.type('text/xml');
  res.send(response);
});

app.post('/voice/menu', (req, res) => {
  const digit = req.body.Digits || '';
  console.log(`🔢 Menu selection: ${digit}`);
  
  let response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>`;
  
  if (digit === '1') {
    response += `<Say voice="Polly.Joanna-Neural">Great! I'll connect you with our sales team.</Say>
    <Dial timeout="30">${FORWARD_TO}</Dial>`;
  } else if (digit === '2') {
    response += `<Say voice="Polly.Joanna-Neural">I'll connect you with our order department.</Say>
    <Dial timeout="30">${FORWARD_TO}</Dial>`;
  } else if (digit === '3') {
    response += `<Say voice="Polly.Joanna-Neural">Connecting you to a representative.</Say>
    <Dial timeout="30">${FORWARD_TO}</Dial>`;
  } else {
    response += `<Say voice="Polly.Joanna-Neural">Let me connect you with someone. Please hold.</Say>
    <Dial timeout="30">${FORWARD_TO}</Dial>`;
  }
  
  response += `</Response>`;
  res.type('text/xml');
  res.send(response);
});

// ============ AI CHAT ============

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
          'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('AI Error:', error.message);
    return "I'm here to help! Please call our team for assistance.";
  }
}

app.post('/ai/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  
  const reply = await getAIResponse(message);
  res.json({ reply });
});

// ============ STATUS ============

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'MiniMax Voice Agent' });
});

app.get('/', (req, res) => {
  res.json({ 
    service: 'MiniMax Voice Agent',
    status: 'running',
    endpoints: [
      '/voice/incoming - Twilio webhook',
      '/ai/chat - AI chat'
    ]
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎙️ Voice agent running on port ${PORT}`));
