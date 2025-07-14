require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const sessions = {};

function buildMessages(session) {
  const messages = [
    {
      role: 'system',
      content:
        `You are a probing interviewer. Your goal is to ask follow-up questions about the given topic until you are satisfied with the depth and quality of the user's answer. The objective is: ${session.objective}. 

IMPORTANT: You should NEVER say "Thank you, your answer is satisfactory" or indicate completion. Your job is only to ask probing questions. The system will determine when the session is complete based on evaluation criteria. Always ask a deeper or more specific follow-up question. Do not answer the question yourself.`,
    },
    { role: 'assistant', content: `The topic is: ${session.topic}` },
  ];
  
  session.history.forEach((turn) => {
    // Only add user message if it exists and is not null/empty
    if (turn.user && turn.user.trim() !== '') {
      messages.push({ role: 'user', content: turn.user });
    }
    // Only add assistant message if it exists and is not null/empty
    if (turn.assistant && turn.assistant.trim() !== '') {
      messages.push({ role: 'assistant', content: turn.assistant });
    }
  });
  
  return messages;
}

app.post('/start', (req, res) => {
  const { topic, objective, numberOfProbes, completeness } = req.body;

  if (!topic) {
    return res.json({ message: 'topic needed.' });
  }
  if (!objective) {
    return res.json({ message: 'objective needed.' });
  }
  if (!numberOfProbes || isNaN(numberOfProbes) || numberOfProbes < 1) {
    return res.json({ message: 'Valid numberOfProbes needed.' });
  }
  if (!completeness || isNaN(completeness) || completeness < 1 || completeness > 100) {
    return res.json({ message: 'Valid completeness percentage (1-100) needed.' });
  }

  const sessionId = uuidv4();
  sessions[sessionId] = {
    topic,
    objective,
    numberOfProbes: Number(numberOfProbes),
    completeness: Number(completeness),
    history: [],
    complete: false,
    probesAsked: 0,
    completenessAchieved: 0,
  };
  res.json({ sessionId, topic, objective, numberOfProbes, completeness });
});

app.post('/start-probe', async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.json({ message: 'sessionId needed.' });
  }

  const session = sessions[sessionId];
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    // Generate first question based on topic and objective
    const firstQuestionMessages = [
      {
        role: 'system',
        content: `You are a probing interviewer. Your goal is to ask follow-up questions about the given topic until you are satisfied with the depth and quality of the user's answer. The objective is: ${session.objective}. 

IMPORTANT: You should NEVER say "Thank you, your answer is satisfactory" or indicate completion. Your job is only to ask probing questions. The system will determine when the session is complete based on evaluation criteria. Ask an initial question to start the conversation. Do not answer the question yourself.`,
      },
      {
        role: 'user',
        content: `Start the probing interview for topic: ${session.topic}. Ask the first question.`,
      },
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: firstQuestionMessages,
      max_tokens: 150,
      temperature: 0.7,
    });

    const firstQuestion = completion.choices[0].message.content;
    
    // Add the first question to session history (without user response yet)
    session.history.push({ assistant: firstQuestion, user: null });
    session.probesAsked = 1;

    res.json({ 
      sessionId, 
      topic: session.topic, 
      objective: session.objective, 
      numberOfProbes: session.numberOfProbes, 
      completeness: session.completeness,
      firstQuestion: firstQuestion
    });
  } catch (err) {
    res.status(500).json({ error: 'OpenAI error', details: err.message });
  }
});

app.post('/reply', async (req, res) => {
  const { sessionId, answer } = req.body;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.complete) return res.json({ message: 'Session already complete.' });

  // Get the current question (last assistant message)
  const lastTurn = session.history[session.history.length - 1];
  const currentQuestion = lastTurn.assistant || '';

  // Add user answer to the last turn
  lastTurn.user = answer;

  console.log(`DEBUG: Current probes asked: ${session.probesAsked}, Max probes: ${session.numberOfProbes}`);

  try {
    // First, evaluate the answer against the current question
    const evaluationMessages = [
      {
        role: 'system',
        content: `You are a strict evaluator. Given the assistant's question and the user's response, return a satisfactory percentage from 0 to 100 based on how well the user answered the question. Consider clarity, depth, and relevance. Only respond with a number.`,
      },
      {
        role: 'user',
        content: `Assistant's question:\n"${currentQuestion}"\n\nUser's answer:\n"${answer}"\n\nWhat is the satisfactory percentage?`,
      },
    ];

    const evaluation = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: evaluationMessages,
      max_tokens: 10,
      temperature: 0.1,
    });

    const satisfactoryPercent = parseInt(evaluation.choices[0].message.content.trim()) || 0;
    session.completenessAchieved = satisfactoryPercent;

    console.log(`DEBUG: Satisfactory percent: ${satisfactoryPercent}, Required: ${session.completeness}`);

    // Check if session should end
    let sessionDone = false;
    let nextQuestion = '';

    if (satisfactoryPercent >= session.completeness&&session.probesAsked >= session.numberOfProbes) {
      // User met the satisfactory threshold - session complete successfully
      sessionDone = true;
      nextQuestion = `✅ Thank you, your answer is satisfactory. Session complete. Satisfactory score: ${satisfactoryPercent}%`;
      console.log('DEBUG: Session complete - satisfactory score reached');
    } else if (session.probesAsked >= session.numberOfProbes) {
      // User has reached maximum probes but didn't meet threshold - session failed
      sessionDone = true;
      nextQuestion = `❌ Session ended. You did not meet the satisfactory score of ${session.completeness}%. You achieved ${satisfactoryPercent}%.`;
      console.log('DEBUG: Session ended - max probes reached');
    } else {
      // Session continues - generate next question
      console.log('DEBUG: Session continues - generating next question');
      const messages = buildMessages(session);
      
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages,
        max_tokens: 150,
        temperature: 0.7,
      });

      nextQuestion = completion.choices[0].message.content;
      session.probesAsked += 1;
      
      // Add the new question to history (without user response yet)
      session.history.push({ assistant: nextQuestion, user: null });
      console.log(`DEBUG: New question added, probes asked now: ${session.probesAsked}`);
    }

    session.complete = sessionDone;

    res.json({
      nextQuestion,
      complete: sessionDone,
      satisfactoryPercent,
      probesAsked: session.probesAsked,
      completenessRequired: session.completeness
    });
  } catch (err) {
    res.status(500).json({ error: 'OpenAI error', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Probe API server running on port ${PORT}`);
});