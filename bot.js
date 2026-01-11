const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const https = require('https');
require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Load shop items
const items = require(path.join(__dirname, 'items.json'));

// Initialize SQLite database
const dbPath = path.join(__dirname, 'users.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to open database:', err);
  } else {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT,
      coins INTEGER DEFAULT 0
    )`, (err) => {
      if (err) console.error('Failed to create users table:', err);
    });
  }
});

// Helper functions for DB (promise-based)
function ensureUserAsync(userId, username) {
  return new Promise((resolve, reject) => {
    db.run('INSERT OR IGNORE INTO users (id, username, coins) VALUES (?, ?, 0)', [userId, username], function(err) {
      if (err) return reject(err);
      db.run('UPDATE users SET username = ? WHERE id = ?', [username, userId], function(err2) {
        if (err2) return reject(err2);
        resolve();
      });
    });
  });
}

function addCoinsAsync(userId, amount) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE users SET coins = coins + ? WHERE id = ?', [amount, userId], function(err) {
      if (err) return reject(err);
      db.get('SELECT coins FROM users WHERE id = ?', [userId], (err2, row) => {
        if (err2) return reject(err2);
        resolve(row ? row.coins : 0);
      });
    });
  });
}

function getCoinsAsync(userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT coins FROM users WHERE id = ?', [userId], (err, row) => {
      if (err) return reject(err);
      resolve(row ? row.coins : 0);
    });
  });
}

// Try to subtract coins; returns { success, balance }
function trySubtractCoinsAsync(userId, amount) {
  return new Promise((resolve, reject) => {
    db.get('SELECT coins FROM users WHERE id = ?', [userId], (err, row) => {
      if (err) return reject(err);
      const current = row ? row.coins : 0;
      if (current < amount) return resolve({ success: false, balance: current });
      db.run('UPDATE users SET coins = coins - ? WHERE id = ?', [amount, userId], function(err2) {
        if (err2) return reject(err2);
        db.get('SELECT coins FROM users WHERE id = ?', [userId], (err3, r2) => {
          if (err3) return reject(err3);
          resolve({ success: true, balance: r2 ? r2.coins : 0 });
        });
      });
    });
  });
}

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

// Track last message timestamp per user to enforce rate limit
const userLastMessageTimestamps = new Map();

// Work command cooldowns (1 minute)
const WORK_COOLDOWN_MS = 60 * 1000;
const workCooldowns = new Map();

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
        - No emojis or em-dashes
        - Don't repeat yourself
        - Don't explain things
        - Don't be overly polite or formal
        - Don't end every message with a question
        - Match the group's energy and humor - be sarcastic, joke around, be edgy or suggestive if they are
        - Don't end messages with "let me know if you have any other questions" or similar phrases
        - DO NOT overuse the word "chaos"

        CONVERSATION STYLE:
        - Use first names or short nicknames when talking to people
        - Reference things said earlier in the conversation
        - Be chill and conversational, not helpful or formal
        - It's okay if conversations get explicit or suggestive as long as no real people are harmed
        - be horny

        IMPORTANT: When you see "(username):" that shows who is speaking. DO NOT start your own messages with their name - just respond naturally.${userContext}`
      }
    ];

    // Add conversation history
if (history.length > 0) {
  messages.push(...history);
}

// Add current message WITH username
messages.push({ role: 'user', content: `${currentUser}: ${prompt}` }); // ADD THE USERNAME BACK

    // removed debug logs

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
      const response = JSON.parse(body);
      
      if (response.error) {
        console.error('OpenAI API Error:', response.error);
        reject(new Error(`OpenAI Error: ${response.error.message}`));
        return;
      }
      
      if (response.choices && response.choices[0]) {
        resolve(response.choices[0].message.content);
      } else {
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

// Bot ready event — register slash command per guild for immediate availability
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    const commands = [
      { name: 'work', description: 'Work to earn 50-100 coins' },
      { name: 'balance', description: 'Show your coin balance' },
      { name: 'shop', description: 'Open the shop to view and buy items' }
    ];

    for (const [guildId, guild] of client.guilds.cache) {
      for (const cmd of commands) {
        try {
          await guild.commands.create(cmd);
        } catch (gerr) {
          console.error(`Failed to register /${cmd.name} in guild ${guildId}:`, gerr);
        }
      }
    }
    console.log('Slash command registration complete');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
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
    } else {
      await message.reply('nuh uh u cant do that');
    }
    return;
  }

  // Store user name
  if (!userNames.has(userId)) {
    userNames.set(userId, displayName);
  }
  // Ensure user exists in the DB
  try {
    await ensureUserAsync(userId, displayName);
  } catch (err) {
    console.error('DB ensureUser error:', err);
  }

  // Check if bot is mentioned
  if (message.mentions.has(client.user)) {
    try {
          // Rate limit: if user sends more than 1 message to the bot within 2 seconds,
          // do not forward to OpenAI. Send a short self-deleting reply to simulate an
          // ephemeral message telling them to slow down.
          const now = Date.now();
          const last = userLastMessageTimestamps.get(userId) || 0;
          if (now - last <= 2000) {
            const warn = await message.reply('please slow down — wait a moment before messaging me.');
            // delete the warning after 5 seconds to simulate ephemeral behaviour
            setTimeout(() => warn.delete().catch(() => {}), 5000);
            // update timestamp so repeated rapid messages remain blocked briefly
            userLastMessageTimestamps.set(userId, now);
            return;
          }
          userLastMessageTimestamps.set(userId, now);

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
    } catch (err) {
      console.error('Error:', err);
      await message.reply('Sorry, I encountered an error while processing your request.');
    }
  }
});

// Login to Discord
client.login(DISCORD_TOKEN);

// Interaction handler for slash commands
client.on('interactionCreate', async (interaction) => {
  // Handle chat commands
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'work') {
    const userId = interaction.user.id;
    const username = interaction.user.username;
    // cooldown check
    const now = Date.now();
    const last = workCooldowns.get(userId) || 0;
    if (now - last < WORK_COOLDOWN_MS) {
      const remaining = Math.ceil((WORK_COOLDOWN_MS - (now - last)) / 1000);
      await interaction.reply({ content: `please wait ${remaining}s before using /work again.`, ephemeral: true });
      return;
    }
    // set cooldown timestamp
    workCooldowns.set(userId, now);
    try {
      await ensureUserAsync(userId, username);
      const earned = Math.floor(Math.random() * 51) + 50; // 50-100
      const newBalance = await addCoinsAsync(userId, earned);
      const embed = new EmbedBuilder()
        .setTitle('💼 work')
        .setDescription(`you worked and earned **${earned}** coins!`)
        .addFields({ name: 'balance', value: `${newBalance} coins`, inline: true })
        .setColor(0x00ff00)
        .setFooter({ text: `requested by ${username}` });
      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error('Slash work error:', err);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp('sorry, could not update your coins.');
      } else {
        await interaction.reply('sorry, could not update your coins.');
      }
    }
      return;
    }

    if (interaction.commandName === 'balance') {
    const userId = interaction.user.id;
    const username = interaction.user.username;
    try {
      await ensureUserAsync(userId, username);
      const balance = await getCoinsAsync(userId);
      const embed = new EmbedBuilder()
        .setTitle('💰 balance')
        .setDescription(`${username}, you have **${balance}** coins.`)
        .setColor(0xffd700)
        .setFooter({ text: 'keep grinding!' });
      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error('Slash balance error:', err);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp('sorry, could not fetch your balance.');
      } else {
        await interaction.reply('sorry, could not fetch your balance.');
      }
    }
    }

    if (interaction.commandName === 'shop') {
      // Build shop embed and buttons
      const embed = new EmbedBuilder()
        .setTitle('🛒 Shop')
        .setDescription('Browse items below and click a button to purchase.')
        .setColor(0x0099ff);

      const lines = items.map(i => `${i.emoji} **${i.displayname}** — ${i.cost} coins`);
      embed.addFields({ name: 'Items', value: lines.join('\n') || 'no items available' });

      const rows = [];
      for (let i = 0; i < items.length; i += 5) {
        const slice = items.slice(i, i + 5);
        const row = new ActionRowBuilder();
        const comps = [];
        for (const it of slice) {
          const btn = new ButtonBuilder()
            .setCustomId(`buy:${it.id}`)
            .setLabel(`${it.emoji} ${it.displayname}`)
            .setStyle(ButtonStyle.Primary);
          comps.push(btn);
        }
        row.addComponents(comps);
        rows.push(row);
      }

      await interaction.reply({ embeds: [embed], components: rows });
    }
    return;
  }

  // Handle button interactions (purchases)
  if (interaction.isButton()) {
    const custom = interaction.customId || '';
    if (!custom.startsWith('buy:')) return;
    const itemId = custom.split(':')[1];
    const item = items.find(x => x.id === itemId);
    if (!item) {
      await interaction.reply({ content: 'item not found.', ephemeral: true });
      return;
    }

    const userId = interaction.user.id;
    const username = interaction.user.username;
    try {
      await ensureUserAsync(userId, username);
      const result = await trySubtractCoinsAsync(userId, item.cost);
      if (!result.success) {
        await interaction.reply({ content: `you need ${item.cost} coins but only have ${result.balance}.`, ephemeral: true });
        return;
      }

      // add item to inventory (best-effort; may be absent depending on schema)
      try { await addItemToInventory(userId, itemId, 1); } catch(e) { /* non-fatal */ }

      const confirm = new EmbedBuilder()
        .setTitle('✅ Purchase complete')
        .setDescription(`${item.emoji} **${item.displayname}** purchased for **${item.cost}** coins.`)
        .addFields({ name: 'balance', value: `${result.balance} coins`, inline: true })
        .setColor(0x00cc66)
        .setFooter({ text: `bought by ${username}` });

      await interaction.reply({ embeds: [confirm], ephemeral: true });
    } catch (err) {
      console.error('Purchase error:', err);
      await interaction.reply({ content: 'could not complete purchase.', ephemeral: true });
    }
    return;
  }
  }
);