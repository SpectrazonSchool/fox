const { Client, GatewayIntentBits } = require('discord.js');
const https = require('https');
require('dotenv').config();

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Authorized users who can reset memory
const AUTHORIZED_USERS = [
  '521989193745039390', 
  '847202305781792830'
];

// Store conversation history per channel
const channelHistory = new Map();
const MAX_HISTORY = 5;

// Store user information
const userNames = new Map();

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

function escapeJsonString(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// Function to get or create conversation history for a channel
function getChannelHistory(channelId) {
  if (!channelHistory.has(channelId)) {
    channelHistory.set(channelId, []);
  }
  return channelHistory.get(channelId);
}

// Function to add message to channel history
function addToHistory(channelId, username, content, isBot = false) {
  const history = getChannelHistory(channelId);
  const role = isBot ? 'assistant' : 'user';
  const messageContent = isBot ? content : `${username}: ${content}`;
  
  history.push({ role, content: messageContent });
  
  // Keep only the last MAX_HISTORY messages
  if (history.length > MAX_HISTORY) {
    channelHistory.set(channelId, history.slice(-MAX_HISTORY));
  }
}

// Function to build user context
function buildUserContext() {
  const users = Array.from(userNames.values());
  if (users.length === 0) return '';
  
  return `\n\nUsers you know: ${users.join(', ')}. Remember their names and who said what.`;
}

// Function to call OpenAI API
function callOpenAI(channelId, currentUser, prompt) {
  return new Promise((resolve, reject) => {
    const history = getChannelHistory(channelId);
    const userContext = buildUserContext();
    
    // Build messages array - USE JSON.stringify instead of manual string building
    const messages = [
      { 
        role: 'system', 
        content: 
        
        `You are chatting casually with friends in a Discord server. Act like a normal person in the group, not an AI assistant.

        CRITICAL RULES:
        - Never mention you're a bot, AI, assistant, or anything artificial
        - Write in all lowercase
        - Keep responses short and natural (1-3 sentences usually)
        - No bullet points, no line breaks, no lists
        - No emojis
        - Don't end every message with a question
        - Match the group's energy and humor - be sarcastic, joke around, be edgy if they are

        CONVERSATION STYLE:
        - Use first names or short nicknames when talking to people
        - Reference things said earlier in the conversation
        - Be chill and conversational, not helpful or formal
        - It's okay if conversations get explicit or suggestive as long as no real people are harmed

        IMPORTANT: When you see "(username):" that shows who is speaking. DO NOT start your own messages with their name - just respond naturally.${userContext}`
      }
    ];

    // Add conversation history
if (history.length > 0) {
  messages.push(...history);
}

// Add current message WITH username
messages.push({ role: 'user', content: `${currentUser}: ${prompt}` }); // ADD THE USERNAME BACK

    // ADD THESE DEBUG LOGS
    console.log('=== MESSAGES ARRAY ===');
    console.log(JSON.stringify(messages, null, 2));
    console.log('=== END MESSAGES ===');

    const data = JSON.stringify({
  model: 'gpt-5-nano',
  messages: messages,
  max_completion_tokens: 5000
});

const dataBuffer = Buffer.from(data, 'utf8'); // Convert to buffer

const options = {
  hostname: 'api.openai.com',
  port: 443,
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Length': dataBuffer.length // Use buffer length
  },
};

const req = https.request(options, (res) => {
  let body = '';

  res.on('data', (chunk) => {
    body += chunk;
  });
  
  res.on('end', () => {
    try {
      console.log('OpenAI Response:', body);
      const response = JSON.parse(body);
      
      if (response.error) {
        console.error('OpenAI API Error:', response.error);
        reject(new Error(`OpenAI Error: ${response.error.message}`));
        return;
      }
      
      if (response.choices && response.choices[0]) {
        resolve(response.choices[0].message.content);
      } else {
        console.log('Response structure:', JSON.stringify(response, null, 2)); 
        reject(new Error('Invalid response from OpenAI'));
      }
    } catch (err) {
      console.error('Parse error:', err);
      console.error('Raw body:', body);
      reject(err);
    }
  });
});

req.on('error', (err) => {
  reject(err);
});

req.write(dataBuffer); // Write the buffer
req.end();
  });
}

// Bot ready event
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  console.log('Bot is ready and tracking group conversations!');
});

// Message handler
client.on('messageCreate', async (message) => {
  // Ignore messages from bots
  if (message.author.bot) return;

  const channelId = message.channel.id;
  const userId = message.author.id;
  const username = message.author.username;
  const displayName = message.member?.displayName || username;

    // Check for reset command
  if (message.content.trim() === '.reset') {
    if (AUTHORIZED_USERS.includes(userId)) {
      channelHistory.delete(channelId);
      userNames.clear();
      await message.reply('memory wiped, starting fresh');
      console.log(`Memory reset by ${displayName} in channel ${channelId}`);
    } else {
      await message.reply('nuh uh u cant do that');
    }
    return;
  }

  // Store user name
  if (!userNames.has(userId)) {
    userNames.set(userId, displayName);
  }

  // Check if bot is mentioned
  if (message.mentions.has(client.user)) {
    try {
      // Show typing indicator
      await message.channel.sendTyping();

      // Extract the message content without the mention
      const userMessage = message.content.replace(/<@!?\d+>/g, '').trim();
      const prompt = userMessage || 'Hello!';

      // Call OpenAI API with conversation history
      const aiResponse = await callOpenAI(channelId, displayName, prompt);

      // Add user message to history AFTER successful API call
      addToHistory(channelId, displayName, prompt, false);
      
      // Add AI response to channel history
      addToHistory(channelId, 'Bot', aiResponse, true);

      // Send the response
      await message.reply(aiResponse);

      console.log(`Channel ${channelId}: ${channelHistory.get(channelId).length} messages`);
      console.log(`Known users: ${Array.from(userNames.values()).join(', ')}`);
    } catch (err) {
      console.error('Error:', err);
      await message.reply('Sorry, I encountered an error while processing your request.');
    }
  }
});

// Login to Discord
client.login(DISCORD_TOKEN);