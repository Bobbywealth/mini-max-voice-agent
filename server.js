const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// Configuration - set these as environment variables
const FORWARD_TO = process.env.FORWARD_TO || '+18089139158';

// AI Persona
const PERSONA = `You are a friendly receptionist for 360 Print Works, a printing company in New Jersey. 
You help customers with:
- Getting quotes for printing services (business cards, brochures, banners, etc)
- Understanding services offered
- Checking order status
- Scheduling appointments
Be friendly, professional, and concise. Keep responses short for voice conversation.
Say exactly what you would speak - no formatting.`;

// ============ VOICE ROUTES (Twilio) ============

// Incoming call handler
app.post('/voice/incoming', (req, res) => {
  const from = req.body.From || 'unknown';
  console.log(`📞 Incoming call from: ${from}`);
  
  const response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Hello! Thank you for calling 360 Print Works, New Jersey's premier printing company. How may I help you today?</Say>
  <Gather numDigits="1" action="/voice/menu" method="POST" timeout="8">
    <Say voice="Polly.Joanna-Neural">Press 1 to get a free quote. Press 2 to check your order status. Press 3 to speak with a representative. Or just tell me how I can help.</Say>
  </Gather>
</Response>`;
  
  res.type('text/xml');
  res.send(response);
});

// Menu handler
app.post('/voice/menu', (req, res) => {
  const digit = req.body.Digits || '';
  console.log(`🔢 Menu selection: ${digit}`);
  
  let response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>`;
  
  if (digit === '1') {
    response += `<Say voice="Polly.Joanna-Neural">Great! I'll connect you with our sales team to get you a custom quote.</Say>
    <Dial timeout="30">${FORWARD_TO}</Dial>`;
  } else if (digit === '2') {
    response += `<Say voice="Polly.Joanna-Neural">I'll connect you with our order tracking department.</Say>
    <Dial timeout="30">${FORWARD_TO}</Dial>`;
  } else if (digit === '3') {
    response += `<Say voice="Polly.Joanna-Neural">Connecting you to a representative. Please hold.</Say>
    <Dial timeout="30">${FORWARD_TO}</Dial>`;
  } else {
    response += `<Say voice="Polly.Joanna-Neural">Let me connect you with someone who can help. Please hold.</Say>
    <Dial timeout="30">${FORWARD_TO}</Dial>`;
  }
  
  response += `</Response>`;
  res.type('text/xml');
  res.send(response);
});

// Voicemail handler
app.post('/voice/voicemail', (req, res) => {
  const response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">We're sorry we missed your call. Please leave a message and we'll call you back shortly.</Say>
  <Record action="/voice/voicemail/save" method="POST" maxLength="30" />
</Response>`;
  
  res.type('text/xml');
  res.send(response);
});

// ============ AI CHAT ROUTE ============

app.post('/ai/chat', async (req, res) => {
  const { message } = req.body;
  
  if (!message) {
    return res.status(400).json({ error: 'Message required' });
  }
  
  try {
    // Use MiniMax for AI chat
    const apiKey = process.env.MINIMAX_API_KEY;
    
    if (!apiKey) {
      return res.json({ 
        reply: "I'm having trouble connecting to my brain right now. Please call back later or visit our website at three60 print works dot on render dot com."
      });
    }
    
    const completion = await axios.post(
      'https://api.minimax.chat/v1/text/chatcompletion_v2',
      {
        model: 'MiniMax-Text-01',
        messages: [
          { role: 'system', content: PERSONA },
          { role: 'user', content: message }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const reply = completion.data?.choices?.[0]?.message?.content || 
                  "I'm here to help! Please call our team for immediate assistance.";
    
    res.json({ reply });
  } catch (error) {
    console.error('AI Error:', error.message);
    res.json({ 
      reply: "I'd be happy to help you! For the fastest service, press 1 to speak with our team." 
    });
  }
});

// ============ TTS (Text to Speech) ============

app.post('/ai/speak', async (req, res) => {
  const { text } = req.body;
  
  if (!text) {
    return res.status(400).json({ error: 'Text required' });
  }
  
  try {
    // Use MiniMax TTS if available, otherwise use Twilio's TTS
    const apiKey = process.env.MINIMAX_API_KEY;
    
    // For now, return Twilio-compatible TTS URL
    // In production, generate audio with MiniMax
    res.json({ 
      audioUrl: null,
      text: text,
      message: 'Use Twilio Say for now'
    });
  } catch (error) {
    res.status(500).json({ error: 'TTS failed' });
  }
});

// ============ STATUS ============

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'MiniMax Voice Agent',
    forwardTo: FORWARD_TO
  });
});

app.get('/', (req, res) => {
  res.json({ 
    service: 'MiniMax Voice Agent',
    routes: [
      '/voice/incoming - Twilio incoming call',
      '/voice/menu - Twilio menu handler',
      '/ai/chat - AI chat endpoint',
      '/ai/speak - TTS endpoint'
    ]
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎙️ Voice agent running on port ${PORT}`));
