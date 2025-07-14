require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const sessions = {};



function buildMessages(session) {
  const messages = [
    {
      role: 'system',
      content:
        'You are a probing interviewer. Your goal is to ask follow-up questions about the given topic until you are satisfied with the depth and quality of the user\'s answer. If the answer is satisfactory, say: "Thank you, your answer is satisfactory. Session complete." Otherwise, ask a deeper or clarifying question. Do not answer the question yourself.',
    },
    { role: 'assistant', content: `The topic is: ${session.topic}` },
  ];
  session.history.forEach((turn) => {
    messages.push({ role: 'user', content: turn.user });
    if (turn.assistant) messages.push({ role: 'assistant', content: turn.assistant });
  });
  return messages;
}

app.post('/start', (req, res) => {
  const { topic } = req.body;

  if(!topic){
    return res.json({ message: 'topic needed.' });
  }

  const sessionId = uuidv4();
  sessions[sessionId] = {
    topic,
    history: [],
    complete: false,
  };
  res.json({ sessionId, topic });
});

app.post('/reply', async (req, res) => {
  const { sessionId, answer } = req.body;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.complete) return res.json({ message: 'Session already complete.' });

  session.history.push({ user: answer });

  const messages = buildMessages(session);

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages,
      max_tokens: 150,
      temperature: 0.7,
    });
    const aiReply = completion.choices[0].message.content;
    session.history[session.history.length - 1].assistant = aiReply;

    if (aiReply.includes('Session complete')) {
      session.complete = true;
    }
    res.json({ aiReply, complete: session.complete });
  } catch (err) {
    res.status(500).json({ error: 'OpenAI error', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Probe API server running on port ${PORT}`);
}); 