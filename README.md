# MiniMax Voice Agent

AI-powered voice receptionist using MiniMax API.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set environment variables:
```bash
export MINIMAX_API_KEY=your-minimax-key
export TWILIO_ACCOUNT_SID=your-twilio-sid
export TWILIO_AUTH_TOKEN=your-twilio-token
export FORWARD_TO=+18089139158
```

3. Run locally:
```bash
npm start
```

## Twilio Setup

1. Buy a Twilio phone number
2. Configure Voice webhook:
   - URL: `https://your-app.onrender.com/voice/incoming`
   - Method: POST

## Routes

- `/voice/incoming` - Handle incoming calls
- `/voice/gather` - Handle keypad input
- `/ai/chat` - Chat with AI
- `/ai/speak` - Text to speech

## Features

- IVR menu (press 1, 2, 3)
- Call forwarding
- AI-powered responses
- MiniMax TTS voice

## Deploy

```bash
gcloud app deploy
```
