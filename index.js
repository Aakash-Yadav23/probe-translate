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
  const { topic, objective, numberOfProbes,priority,questionNumber, completeness, firstQuestion } = req.body;

  let priorityVise="completeness"|"probes";
  if(priority==="completeness"){
    priorityVise="completeness";
  }else{
    priorityVise="probes";
  }

  if (!topic) {
    return res.json({ message: 'topic needed.' });
  }

  if (!questionNumber) {
    return res.json({ message: 'questionNumber needed.' });
  }

  if (!priority) {
    return res.json({ message: 'priority needed.' });
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
  if (!firstQuestion || typeof firstQuestion !== 'string' || firstQuestion.trim() === '') {
    return res.json({ message: 'firstQuestion needed.' });
  }

  const sessionId = uuidv4();
  const respondentId = uuidv4();
  sessions[sessionId] = {
    topic,
    objective,
    numberOfProbes: Number(numberOfProbes),
    completeness: Number(completeness),
    history: [{ assistant: firstQuestion, user: null }], // Store first question
    complete: false,
    probesAsked: 1, // First probe already asked
    completenessAchieved: 0,
    currentQuestionAttempts: 1,
    currentQuestionIndex: 0,
    priority:priorityVise,
    questionNumber,
    questionScores: [], // Store individual question scores
    totalScore: 0, // Running total score
    respondentId, // Store respondentId
  };
  res.json({ sessionId, respondentId, topic, objective,questionNumber,priority, numberOfProbes, completeness });
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

  // If the session already has a first question in history, return it
  if (session.history && session.history.length > 0 && session.history[0].assistant) {
    return res.json({
      sessionId,
      respondentId: session.respondentId,
      topic: session.topic,
      objective: session.objective,
      numberOfProbes: session.numberOfProbes,
      questionNumber: session.questionNumber,
      priority: session.priority,
      completeness: session.completeness,
      firstQuestion: session.history[0].assistant
    });
  }

  try {
    // Generate first question based on topic and objective
    const firstQuestionMessages = [
      {
        role: 'system',
        content: `You are a probing interviewer. Your goal is to ask follow-up questions about the given topic until you are satisfied with the depth and quality of the user's answer. The objective is: ${session.objective}. \n\nIMPORTANT: You should NEVER say "Thank you, your answer is satisfactory" or indicate completion. Your job is only to ask probing questions. The system will determine when the session is complete based on evaluation criteria. Ask an initial question to start the conversation. Do not answer the question yourself.`,
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
    session.history = [{ assistant: firstQuestion, user: null }];
    session.probesAsked = 1;
    session.currentQuestionAttempts = 1;

    res.json({ 
      sessionId, 
      respondentId: session.respondentId,
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
    // First, check if the answer is relevant to the question with stricter criteria
    const relevanceMessages = [
      {
        role: 'system',
        content: `You are a very strict relevance evaluator. Given a question and a user's answer, determine if the answer is relevant to the question. Be extremely strict:
        
        1. Does the answer DIRECTLY address the core question being asked?
        2. Is the answer specific to the topic, not generic or vague?
        3. Does the answer provide meaningful, substantive information related to the question?
        4. Reject answers that are too short, generic, or obviously nonsensical
        5. Reject answers that don't demonstrate understanding of the question
        
        Examples of IRRELEVANT answers:
        - "Yes", "No", "I don't know" without explanation
        - Random words or gibberish
        - Answers that completely ignore the question
        - Generic statements that could apply to anything
        - Answers shorter than 10 words unless they're genuinely complete
        
        Only respond with "RELEVANT" or "IRRELEVANT". Be very strict - when in doubt, mark as IRRELEVANT.`,
      },
      {
        role: 'user',
        content: `Question: "${currentQuestion}"\n\nUser's answer: "${answer}"\n\nIs this answer relevant and substantive enough to merit evaluation?`,
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
    if (
      !isRelevant &&
      (
        (session.priority === "probes" && session.currentQuestionAttempts < 5) ||
        (session.priority !== "probes")
      )
    ) {
      session.currentQuestionAttempts += 1;
      
      // Generate a rephrased version of the same question
      const rephraseMessages = [
        {
          role: 'system',
          content: `You are a probing interviewer. The user gave an irrelevant or inadequate answer to your question. Rephrase the same question in a different way to make it clearer and more specific. The objective is: ${session.objective}. 

IMPORTANT: You should ask the SAME question but with different wording to help the user understand what you're looking for. Do not move to a new question. Make it more specific and clear. Add examples if needed.`,
        },
        {
          role: 'user',
          content: `Original question: "${currentQuestion}"\nUser's irrelevant/inadequate answer: "${answer}"\n\nPlease rephrase the question to make it clearer and more specific.`,
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
        totalScore: Math.round(session.totalScore / Math.max(1, session.questionScores.length)),
        probesAsked: session.probesAsked,
        completenessRequired: session.completeness,
        message: `Please provide a relevant and detailed answer to the question. This is attempt ${session.currentQuestionAttempts} of 5.`
      });
    }

    // Add user answer to the last turn
    lastTurn.user = answer;

    let currentQuestionScore = 0;

    // If answer is relevant, evaluate it properly with stricter criteria
    if (isRelevant) {
      const evaluationMessages = [
        {
          role: 'system',
          content: `You are an extremely strict evaluator. Given the assistant's question and the user's response, return a satisfactory percentage from 0 to 100. BE VERY STRICT:

Scoring criteria:
1. Direct relevance to the question (30%)
2. Depth and detail of the answer (25%)
3. Accuracy and correctness (20%)
4. Clarity and coherence (15%)
5. Completeness of the response (10%)

STRICT GUIDELINES:
- 90-100: Exceptional, comprehensive, expert-level answers with deep insight
- 80-89: Very good answers with good depth and accuracy
- 70-79: Good answers that adequately address the question
- 60-69: Acceptable answers with basic information
- 50-59: Weak answers that barely address the question
- 30-49: Poor answers with minimal relevant content
- 10-29: Very poor answers with little relevance
- 0-9: Nonsensical or completely irrelevant answers

Be extremely strict. Most answers should score between 30-70. Only truly exceptional answers deserve 80+. Generic, short, or shallow answers should score low.

Only respond with a number between 0-100.`,
        },
        {
          role: 'user',
          content: `Question: "${currentQuestion}"\n\nUser's answer: "${answer}"\n\nWhat is the satisfactory percentage (0-100)? Be very strict.`,
        },
      ];

      const evaluation = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: evaluationMessages,
        max_tokens: 10,
        temperature: 0.1,
      });

      currentQuestionScore = parseInt(evaluation.choices[0].message.content.trim()) || 0;
      
      // Additional safety check - if answer is too short or generic, cap the score
      if (answer.trim().length < 10 || answer.toLowerCase().includes('i don\'t know')) {
        currentQuestionScore = Math.min(currentQuestionScore, 20);
      }
    } else {
      // If still irrelevant after attempts, give a very low score
      currentQuestionScore = 5;
      console.log('DEBUG: Irrelevant answer after attempts, assigning very low score');
    }

    // Store the score for this question
    session.questionScores.push(currentQuestionScore);
    
    // Calculate total score as sum of all scores (not average)
    session.totalScore = session.questionScores.reduce((sum, score) => sum + score, 0);

    console.log(`DEBUG: Current question score: ${currentQuestionScore}`);
    console.log(`DEBUG: All question scores: ${session.questionScores.join(', ')}`);
    console.log(`DEBUG: Total score: ${session.totalScore}, Required: ${session.completeness * session.numberOfProbes}`);

    // Check if session should end
    let sessionDone = false;
    let nextQuestion = '';

    // Calculate required total score (completeness percentage * number of probes)
    const requiredTotalScore = session.completeness;

    if (session.totalScore >= requiredTotalScore&&session.priority==="completeness"||session.probesAsked>=session.numberOfProbes&&session.priority==="probes") {
      sessionDone = true;
      nextQuestion = `✅ Thank you, your answers are satisfactory. Session complete. Total score: ${session.totalScore}/${requiredTotalScore} required.`;
      console.log('DEBUG: Session complete - satisfactory total score reached');
    } else if (session.probesAsked >= session.numberOfProbes) {
      // User has reached maximum probes but didn't meet threshold - session failed
      sessionDone = true;
      nextQuestion = `❌ Session ended. You did not meet the required total score of ${requiredTotalScore}. You achieved ${session.totalScore} total score.`;
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
      respondentId: session.respondentId,
      complete: sessionDone,
      totalScore: session.totalScore,
      requiredTotalScore: requiredTotalScore,
      probesAsked: session.probesAsked,
      completenessRequired: session.completeness,
      wasRelevant: isRelevant,
      attempts: session.currentQuestionAttempts
    });
  } catch (err) {
    res.status(500).json({ error: 'OpenAI error', details: err.message });
  }
});

app.get('/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({ sessionId, ...session });
});

app.get('/session/respondent/:respondentId', (req, res) => {
  const { respondentId } = req.params;
  const sessionId = Object.keys(sessions).find(
    (id) => sessions[id].respondentId === respondentId
  );
  if (!sessionId) {
    return res.status(404).json({ error: 'Session not found for respondentId' });
  }
  res.json({ sessionId, ...sessions[sessionId] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Probe API server running on port ${PORT}`);
});