const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const FORWARD_TO = process.env.FORWARD_TO || '+18089139158';
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// AI Persona
const PERSONA = `You are a friendly receptionist for 360 Print Works, a printing company in New Jersey.
You help customers with:
- Getting quotes for printing services
- Checking order status
- Questions about services
Be brief, friendly, and helpful. Keep responses under 30 words.`;

// ============ VOICE ROUTES ============

app.post('/voice/incoming', async (req, res) => {
  const from = req.body.From || 'unknown';
  console.log(`📞 Call from: ${from}`);
  
  // Start with greeting and enable speech recognition
  const response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Hello! Thank you for calling 360 Print Works in New Jersey. How can I help you today?</Say>
  <Gather input="speech" action="/voice/listen" method="POST" timeout="8" speechTimeout="5" language="en-US">
    <Say voice="Polly.Joanna-Neural">Just tell me what you need, or press 1 to speak with someone.</Say>
  </Gather>
</Response>`;
  
  res.type('text/xml');
  res.send(response);
});

// Handle speech input - THIS IS WHERE 2-WAY HAPPENS
app.post('/voice/listen', async (req, res) => {
  const speechResult = req.body.SpeechResult || '';
  const digit = req.body.Digits || '';
  
  console.log(`🗣️ Speech: "${speechResult}", Digit: "${digit}"`);
  
  let response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>`;
  
  // Handle digit press
  if (digit === '1' || digit === '2' || digit === '3') {
    response += `<Say voice="Polly.Joanna-Neural">Connecting you to our team now.</Say>
    <Dial timeout="30">${FORWARD_TO}</Dial>`;
  }
  // Handle speech - get AI response
  else if (speechResult && speechResult.length > 2) {
    try {
      // Send to AI
      const aiReply = await getAIResponse(speechResult);
      console.log(`🤖 AI: ${aiReply}`);
      
      response += `<Say voice="Polly.Joanna-Neural">${aiReply}</Say>`;
      
      // Continue conversation - loop back
      response += `<Gather input="speech" action="/voice/listen" method="POST" timeout="10" speechTimeout="6">
        <Say voice="Polly.Joanna-Neural">Is there anything else I can help with?</Say>
      </Gather>`;
      
    } catch (error) {
      console.error('AI Error:', error.message);
      response += `<Say voice="Polly.Joanna-Neural">I'm having trouble understanding. Let me connect you with someone.</Say>
      <Dial>${FORWARD_TO}</Dial>`;
    }
  }
  // No input - forward
  else {
    response += `<Say voice="Polly.Joanna-Neural">Let me connect you with someone who can help.</Say>
    <Dial timeout="30">${FORWARD_TO}</Dial>`;
  }
  
  response += `</Response>`;
  res.type('text/xml');
  res.send(response);
});

// ============ AI FUNCTION ============

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
    
    // Keep short for voice
    if (reply.length > 200) {
      reply = reply.substring(0, 200);
    }
    
    return reply;
  } catch (error) {
    console.error('AI Error:', error.message);
    return "I'd be happy to help you with that. Can you tell me more?";
  }
}

// ============ STATUS ============

app.post('/ai/chat', async (req, res) => {
  const { message } = req.body;
  const reply = await getAIResponse(message || 'hello');
  res.json({ reply });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', type: '2-way voice with Deepgram + MiniMax' });
});

app.get('/', (req, res) => {
  res.json({ 
    service: '2-Way Voice Agent',
    features: ['Speech recognition', 'AI conversation', 'Call forwarding']
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎙️ 2-Way Voice ready on port ${PORT}`));
