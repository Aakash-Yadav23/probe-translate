# Probe Knowledge API

A Node.js API that uses OpenAI to probe a user on a given topic, asking follow-up questions until a satisfactory answer is received.

## Setup

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file in the root directory with your OpenAI API key:
   ```env
   OPENAI_API_KEY=your_openai_api_key_here
   PORT=3000
   ```
4. Start the server:
   ```bash
   node index.js
   ```

## API Endpoints

### 1. Start a Session
- **POST** `/start`
- **Response:**
  ```json
  {
    "sessionId": "...",
    "topic": "..."
  }
  ```

### 2. Reply to the Probe
- **POST** `/reply`
- **Body:**
  ```json
  {
    "sessionId": "...",
    "answer": "..."
  }
  ```
- **Response:**
  ```json
  {
    "aiReply": "...",
    "complete": false
  }
  ```
  If the session is complete, `complete` will be `true` and the AI will say so.

## Example Flow
1. Start a session: `POST /start` → receive a topic and sessionId.
2. User answers: `POST /reply` with sessionId and answer.
3. AI replies with a follow-up or ends the session if satisfied.

## Notes
- Sessions are stored in memory. Restarting the server will clear all sessions.
- You can customize the topics in `index.js`. 