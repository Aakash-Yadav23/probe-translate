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
    currentQuestionAttempts: 0,
    currentQuestionIndex: 0,
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
    session.currentQuestionAttempts = 1;

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

  console.log(`DEBUG: Current probes asked: ${session.probesAsked}, Max probes: ${session.numberOfProbes}`);
  console.log(`DEBUG: Current question attempts: ${session.currentQuestionAttempts}`);

  try {
    // First, check if the answer is relevant to the question
    const relevanceMessages = [
      {
        role: 'system',
        content: `You are a strict relevance evaluator. Given a question and a user's answer, determine if the answer is relevant to the question. Consider:
        1. Does the answer address the question directly?
        2. Is the answer on-topic?
        3. Does the answer provide meaningful information related to the question?
        
        Respond with only "RELEVANT" or "IRRELEVANT".`,
      },
      {
        role: 'user',
        content: `Question: "${currentQuestion}"\n\nUser's answer: "${answer}"\n\nIs this answer relevant to the question?`,
      },
    ];

    const relevanceCheck = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: relevanceMessages,
      max_tokens: 10,
      temperature: 0.1,
    });

    const isRelevant = relevanceCheck.choices[0].message.content.trim().toUpperCase() === 'RELEVANT';
    
    console.log(`DEBUG: Answer relevance: ${isRelevant ? 'RELEVANT' : 'IRRELEVANT'}`);

    // If answer is irrelevant and we haven't reached max attempts, rephrase the question
    if (!isRelevant && session.currentQuestionAttempts < 5) {
      session.currentQuestionAttempts += 1;
      
      // Generate a rephrased version of the same question
      const rephraseMessages = [
        {
          role: 'system',
          content: `You are a probing interviewer. The user gave an irrelevant answer to your question. Rephrase the same question in a different way to make it clearer and more specific. The objective is: ${session.objective}. 

IMPORTANT: You should ask the SAME question but with different wording to help the user understand what you're looking for. Do not move to a new question. Make it more specific and clear.`,
        },
        {
          role: 'user',
          content: `Original question: "${currentQuestion}"\nUser's irrelevant answer: "${answer}"\n\nPlease rephrase the question to make it clearer and more specific.`,
        },
      ];

      const rephraseCompletion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: rephraseMessages,
        max_tokens: 150,
        temperature: 0.7,
      });

      const rephrasedQuestion = rephraseCompletion.choices[0].message.content;
      
      // Update the current question in history
      lastTurn.assistant = rephrasedQuestion;
      lastTurn.user = null; // Reset user response for the rephrased question
      
      console.log(`DEBUG: Question rephrased (attempt ${session.currentQuestionAttempts}/5)`);
      
      return res.json({
        nextQuestion: rephrasedQuestion,
        complete: false,
        satisfactoryPercent: 0,
        probesAsked: session.probesAsked,
        completenessRequired: session.completeness,
        message: `Please provide a relevant answer to the question. This is attempt ${session.currentQuestionAttempts} of 5.`
      });
    }

    // Add user answer to the last turn
    lastTurn.user = answer;

    let satisfactoryPercent = 0;

    // If answer is relevant, evaluate it properly
    if (isRelevant) {
      const evaluationMessages = [
        {
          role: 'system',
          content: `You are a strict evaluator. Given the assistant's question and the user's response, return a satisfactory percentage from 0 to 100 based on:
          1. How well the user answered the question (relevance: 40%)
          2. Depth and detail of the answer (30%)
          3. Clarity and coherence (20%)
          4. Completeness of the response (10%)
          
          Be strict in your evaluation. Only excellent, comprehensive answers should score above 80%. Average answers should score 40-60%. Poor but relevant answers should score 20-40%. Only respond with a number.`,
        },
        {
          role: 'user',
          content: `Question: "${currentQuestion}"\n\nUser's answer: "${answer}"\n\nWhat is the satisfactory percentage (0-100)?`,
        },
      ];

      const evaluation = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: evaluationMessages,
        max_tokens: 10,
        temperature: 0.1,
      });

      satisfactoryPercent = parseInt(evaluation.choices[0].message.content.trim()) || 0;
    } else {
      // If still irrelevant after 5 attempts, give a low score
      satisfactoryPercent = 10; // Low score for irrelevant answers
      console.log('DEBUG: Max attempts reached with irrelevant answer, assigning low score');
    }

    session.completenessAchieved = satisfactoryPercent;

    console.log(`DEBUG: Satisfactory percent: ${satisfactoryPercent}, Required: ${session.completeness}`);

    // Check if session should end
    let sessionDone = false;
    let nextQuestion = '';

    if (satisfactoryPercent >= session.completeness && session.probesAsked >= session.numberOfProbes) {
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
      session.currentQuestionAttempts = 1; // Reset attempts for new question
      
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
      completenessRequired: session.completeness,
      wasRelevant: isRelevant,
      attempts: session.currentQuestionAttempts
    });
  } catch (err) {
    res.status(500).json({ error: 'OpenAI error', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Probe API server running on port ${PORT}`);
});