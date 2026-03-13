const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const FORWARD_TO = process.env.FORWARD_TO || '+18089139158';
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;

// AI Persona
const PERSONA = `You are a friendly receptionist for 360 Print Works, a printing company in New Jersey. 
Be brief and helpful.`;

// ============ VOICE ROUTES ============

app.post('/voice/incoming', (req, res) => {
  const from = req.body.From || 'unknown';
  console.log(`📞 Call from: ${from}`);
  
  const response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Thank you for calling 360 Print Works. How may I help you today?</Say>
  <Gather numDigits="1" action="/voice/menu" method="POST" timeout="10">
    <Say voice="Polly.Joanna-Neural">Press 1 for a free quote. Press 2 to check your order. Press 3 for our address. Or hold the line to speak with someone.</Say>
  </Gather>
</Response>`;
  
  res.type('text/xml');
  res.send(response);
});

app.post('/voice/menu', async (req, res) => {
  const digit = req.body.Digits || '';
  console.log(`🔢 Pressed: ${digit}`);
  
  let response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>`;
  
  if (digit === '1') {
    response += `<Say voice="Polly.Joanna-Neural">Great! Let me connect you with our sales team for a free quote.</Say>
    <Dial timeout="25">${FORWARD_TO}</Dial>`;
  } else if (digit === '2') {
    response += `<Say voice="Polly.Joanna-Neural">I'll connect you with order tracking.</Say>
    <Dial timeout="25">${FORWARD_TO}</Dial>`;
  } else if (digit === '3') {
    response += `<Say voice="Polly.Joanna-Neural">We're located at 85 May Street in Irvington, New Jersey.</Say>
    <Gather numDigits="1" action="/voice/menu" method="POST" timeout="8">
      <Say voice="Polly.Joanna-Neural">Press 1 to speak with someone.</Say>
    </Gather>`;
  } else {
    // No response - hold for operator
    response += `<Say voice="Polly.Joanna-Neural">Connecting you now.</Say>
    <Dial timeout="25">${FORWARD_TO}</Dial>`;
  }
  
  response += `</Response>`;
  res.type('text/xml');
  res.send(response);
});

// ============ AI CHAT ============

app.post('/ai/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  
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
    
    const reply = response.data.choices[0].message.content;
    res.json({ reply: reply.substring(0, 200) });
  } catch (error) {
    console.error('AI Error:', error.message);
    res.json({ reply: 'How can I help you today?' });
  }
});

// ============ STATUS ============

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.json({ service: 'Voice Agent', status: 'running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎙️ Voice agent ready on port ${PORT}`));
