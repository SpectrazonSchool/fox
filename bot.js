const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const https = require('https');
require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');

const items = require(path.join(__dirname, 'items.json'));
const chests = require(path.join(__dirname, 'chests.json'));

let db;

const itemFunctions = {
  chest: async ({ userId, item }) => {
    const chestId = item.id;
    const chestData = chests[chestId];
    
    if (!chestData) {
      return { success: false, message: `chest data not found for ${item.displayname}` };
    }
    
    const itemPool = chestData.items || [];
    if (itemPool.length === 0) {
      return { success: false, message: `${item.displayname} has no items to give` };
    }
    
    const rewards = [];

    for (const poolItem of itemPool) {
      const rawWeight = typeof poolItem.weight === 'number' ? poolItem.weight : 0;
      let chance = rawWeight;
      if (chance > 1) chance = chance / 100;
      if (chance < 0) chance = 0;
      if (chance > 1) chance = 1;

      if (Math.random() < chance) {
        const minA = Number.isFinite(poolItem.min_amt) ? poolItem.min_amt : 1;
        const maxA = Number.isFinite(poolItem.max_amt) ? poolItem.max_amt : minA;
        const amt = Math.floor(Math.random() * (maxA - minA + 1)) + minA;
        rewards.push({ itemid: poolItem.itemid, qty: amt });
      }
    }

    // If nothing dropped, fallback to a single weighted pick so players always get something
    if (rewards.length === 0) {
      const totalWeight = itemPool.reduce((sum, i) => sum + (i.weight || 0), 0) || 1;
      const r = Math.random() * totalWeight;
      let acc = 0;
      let pick = itemPool[0];
      for (const p of itemPool) {
        acc += (p.weight || 0);
        if (r <= acc) { pick = p; break; }
      }
      const minA = Number.isFinite(pick.min_amt) ? pick.min_amt : 1;
      const maxA = Number.isFinite(pick.max_amt) ? pick.max_amt : minA;
      const amt = Math.floor(Math.random() * (maxA - minA + 1)) + minA;
      rewards.push({ itemid: pick.itemid, qty: amt });
    }

    // Use transaction for safety
    try {
      db.exec('BEGIN TRANSACTION');
      
      for (const reward of rewards) {
        try {
          addItemToInventory(userId, reward.itemid, reward.qty);
        } catch (e) {
          console.error('Error adding chest drop to inventory:', e);
          db.exec('ROLLBACK');
          return { success: false, message: 'Failed to process chest drops' };
        }
      }
      
      db.exec('COMMIT');
    } catch (e) {
      console.error('Transaction error during chest open:', e);
      try { db.exec('ROLLBACK'); } catch (e2) {}
      return { success: false, message: 'Failed to process chest' };
    }

    const parts = rewards.map(rw => {
      const meta = items.find(it => it.id === rw.itemid);
      if (meta) return `${meta.emoji || ''} **${meta.displayname || rw.itemid}** x${rw.qty}`;
      return `${rw.itemid} x${rw.qty}`;
    });

    return { success: true, message: `You opened ${item.displayname} and received: ${parts.join(', ')}` };
  }
};

async function initializeDatabase() {
  const dbPath = path.join(__dirname, 'users.db');
  db = new Database(dbPath);
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT,
      coins INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS inventory (
      user_id TEXT,
      item_id TEXT,
      qty INTEGER DEFAULT 0,
      PRIMARY KEY(user_id, item_id)
    );
    CREATE TABLE IF NOT EXISTS image_generations (
      user_id TEXT,
      timestamp INTEGER,
      PRIMARY KEY(user_id, timestamp)
    );
  `);
  
  console.log('Database initialized');
}

// Wrapper functions for better-sqlite3
const dbAsync = {
  run: (sql, params = []) => {
    const stmt = db.prepare(sql);
    return stmt.run(...params);
  },
  get: (sql, params = []) => {
    const stmt = db.prepare(sql);
    return stmt.get(...params);
  },
  all: (sql, params = []) => {
    const stmt = db.prepare(sql);
    return stmt.all(...params);
  }
};

function ensureUserAsync(userId, username) {
  dbAsync.run('INSERT OR IGNORE INTO users (id, username, coins) VALUES (?, ?, 0)', [userId, username]);
  dbAsync.run('UPDATE users SET username = ? WHERE id = ?', [username, userId]);
}

function addCoinsAsync(userId, amount) {
  dbAsync.run('UPDATE users SET coins = coins + ? WHERE id = ?', [amount, userId]);
  const row = dbAsync.get('SELECT coins FROM users WHERE id = ?', [userId]);
  return row ? row.coins : 0;
}

function getCoinsAsync(userId) {
  const row = dbAsync.get('SELECT coins FROM users WHERE id = ?', [userId]);
  return row ? row.coins : 0;
}

function trySubtractCoinsAsync(userId, amount) {
  const row = dbAsync.get('SELECT coins FROM users WHERE id = ?', [userId]);
  const current = row ? row.coins : 0;
  if (current < amount) return { success: false, balance: current };
  
  dbAsync.run('UPDATE users SET coins = coins - ? WHERE id = ?', [amount, userId]);
  const updatedRow = dbAsync.get('SELECT coins FROM users WHERE id = ?', [userId]);
  return { success: true, balance: updatedRow ? updatedRow.coins : 0 };
}

function addItemToInventory(userId, itemId, qty = 1) {
  dbAsync.run(
    'INSERT INTO inventory (user_id, item_id, qty) VALUES (?, ?, ?) ON CONFLICT(user_id, item_id) DO UPDATE SET qty = qty + excluded.qty',
    [userId, itemId, qty]
  );
}

function getItemQty(userId, itemId) {
  const row = dbAsync.get('SELECT qty FROM inventory WHERE user_id = ? AND item_id = ?', [userId, itemId]);
  return row ? row.qty : 0;
}

function getUserInventory(userId) {
  const rows = dbAsync.all('SELECT item_id, qty FROM inventory WHERE user_id = ? AND qty > 0 ORDER BY item_id', [userId]);
  return rows || [];
}

function removeItemFromInventory(userId, itemId, qty = 1) {
  dbAsync.run('UPDATE inventory SET qty = qty - ? WHERE user_id = ? AND item_id = ? AND qty >= ?', [qty, userId, itemId, qty]);
  dbAsync.run('DELETE FROM inventory WHERE user_id = ? AND item_id = ? AND qty <= 0', [userId, itemId]);
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const AUTHORIZED_USERS = [
  '521989193745039390', 
  '847202305781792830'
];

const channelHistory = new Map();
const MAX_HISTORY = 5;

const userNames = new Map();

const userLastMessageTimestamps = new Map();

const WORK_COOLDOWN_MS = 60 * 1000;
const workCooldowns = new Map();

const IMAGE_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

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

// Helper function to build shop display
function buildShopDisplay(page) {
  const itemsByPage = {};
  items.forEach(item => {
    const pageNum = item.page || 1;
    if (!itemsByPage[pageNum]) itemsByPage[pageNum] = [];
    itemsByPage[pageNum].push(item);
  });

  const pages = Object.keys(itemsByPage).map(Number).sort((a, b) => a - b);
  const maxPage = pages.length > 0 ? Math.max(...pages) : 1;
  const validPage = Math.max(1, Math.min(page, maxPage));
  const pageItems = itemsByPage[validPage] || [];

  const embed = new EmbedBuilder()
    .setTitle('🛒 Shop')
    .setDescription(`Page ${validPage} of ${maxPage}`)
    .setColor(0x0099ff);

  const lines = pageItems.map(i => `${i.emoji} **${i.displayname}** — ${i.cost} coins`);
  embed.addFields({ name: 'Items', value: lines.join('\n') || 'no items on this page' });

  const rows = [];
  const buyRow = new ActionRowBuilder();
  const comps = [];
  
  for (const it of pageItems) {
    const btn = new ButtonBuilder()
      .setCustomId(`buy:${it.id}`)
      .setLabel(`${it.emoji} ${it.displayname}`)
      .setStyle(ButtonStyle.Primary);
    comps.push(btn);
  }
  
  if (comps.length > 0) {
    buyRow.addComponents(comps);
    rows.push(buyRow);
  }

  const navRow = new ActionRowBuilder();
  if (validPage > 1) {
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`shop_prev:${validPage - 1}`)
        .setLabel('⬅ Previous')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  if (validPage < maxPage) {
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`shop_next:${validPage + 1}`)
        .setLabel('Next ➡')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  if (navRow.components.length > 0) {
    rows.push(navRow);
  }

  return { embeds: [embed], components: rows };
}

// Function to get or create conversation history for a channel
function getChannelHistory(channelId) {
  if (!channelHistory.has(channelId)) {
    channelHistory.set(channelId, []);
  }
  return channelHistory.get(channelId);
}

function addToHistory(channelId, username, content, isBot = false) {
  const history = getChannelHistory(channelId);
  const role = isBot ? 'assistant' : 'user';
  const messageContent = isBot ? content : `${username}: ${content}`;
  
  history.push({ role, content: messageContent });
  
  if (history.length > MAX_HISTORY) {
    channelHistory.set(channelId, history.slice(-MAX_HISTORY));
  }
}

function buildUserContext() {
  const users = Array.from(userNames.values());
  if (users.length === 0) return '';
  
  return `\n\nUsers you know: ${users.join(', ')}. Remember their names and who said what.`;
}

function checkImageGenerationCooldown(userId) {
  // If authorized user, always allow
  if (AUTHORIZED_USERS.includes(userId)) {
    return { allowed: true, timeRemaining: 0 };
  }
  
  const now = Date.now();
  const thirtyMinutesAgo = now - IMAGE_COOLDOWN_MS;
  
  // Get image generations from the last 30 minutes
  const recentGenerations = dbAsync.all(
    'SELECT timestamp FROM image_generations WHERE user_id = ? AND timestamp > ?',
    [userId, thirtyMinutesAgo]
  );
  
  const count = recentGenerations.length;
  
  // If user has 2 or more generations, check time until next one is available
  if (count >= 2) {
    const oldestGeneration = recentGenerations[0].timestamp;
    const timeRemaining = Math.ceil((oldestGeneration + IMAGE_COOLDOWN_MS - now) / 1000);
    return { allowed: false, timeRemaining };
  }
  
  return { allowed: true, timeRemaining: 0 };
}

function recordImageGeneration(userId) {
  const now = Date.now();
  dbAsync.run(
    'INSERT INTO image_generations (user_id, timestamp) VALUES (?, ?)',
    [userId, now]
  );
}

function formatTimeRemaining(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  
  if (minutes === 0) {
    return `${remainingSeconds}s`;
  } else if (minutes === 1) {
    return `1m ${remainingSeconds}s`;
  } else {
    return `${minutes}m ${remainingSeconds}s`;
  }
}

function generateImage(description) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'dall-e-3',
      prompt: description,
      n: 1,
      size: '1024x1024'
    });

    const dataBuffer = Buffer.from(data, 'utf8');

    const options = {
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/images/generations',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': dataBuffer.length
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
            console.error('OpenAI Image API Error:', response.error);
            reject(new Error(`Image generation failed: ${response.error.message}`));
            return;
          }
          
          if (response.data && response.data[0] && response.data[0].url) {
            resolve(response.data[0].url);
          } else {
            reject(new Error('Invalid response from image API'));
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

    req.write(dataBuffer);
    req.end();
  });
}

function callOpenAI(channelId, currentUser, prompt) {
  return new Promise((resolve, reject) => {
    const history = getChannelHistory(channelId);
    const userContext = buildUserContext();
    
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

        IMAGE GENERATION:
        - You can generate images by responding with: IMAGE_GENERATION: [detailed description of the image]
        - Only generate images when asked or when it makes sense in conversation

        CONVERSATION STYLE:
        - Use first names or short nicknames when talking to people
        - Reference things said earlier in the conversation
        - Be chill and conversational, not helpful or formal
        - It's okay if conversations get explicit or suggestive as long as no real people are harmed
        - be horny

        IMPORTANT: When you see "(username):" that shows who is speaking. DO NOT start your own messages with their name - just respond naturally.${userContext}`
      }
    ];

if (history.length > 0) {
  messages.push(...history);
}

messages.push({ role: 'user', content: `${currentUser}: ${prompt}` });

    const data = JSON.stringify({
  model: 'gpt-5-nano',
  messages: messages,
  max_completion_tokens: 5000
});

const dataBuffer = Buffer.from(data, 'utf8');

const options = {
  hostname: 'api.openai.com',
  port: 443,
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Length': dataBuffer.length
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

req.write(dataBuffer);
req.end();
  });
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  
  // Initialize database
  try {
    await initializeDatabase();
  } catch (err) {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  }
  
  try {
    const commands = [
        { name: 'work', description: 'Work to earn 50-100 coins' },
        { name: 'balance', description: 'Show your coin balance' },
        { name: 'shop', description: 'Open the shop to view and buy items' },
        { name: 'inventory', description: 'View your inventory' },
        { name: 'use', description: 'Use an item from your inventory', options: [
          { name: 'item_id', description: 'ID of the item to use', type: 3, required: true },
          { name: 'quantity', description: 'How many of the item to use', type: 4, required: false }
        ] }
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

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const channelId = message.channel.id;
  const userId = message.author.id;
  const username = message.author.username;
  const displayName = message.member?.displayName || username;

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

  if (!userNames.has(userId)) {
    userNames.set(userId, displayName);
  }
  try {
    ensureUserAsync(userId, displayName);
  } catch (err) {
    console.error('DB ensureUser error:', err);
  }

  if (message.mentions.has(client.user)) {
    try {
          const now = Date.now();
          const last = userLastMessageTimestamps.get(userId) || 0;
          if (now - last <= 2000) {
            const warn = await message.reply('please slow down — wait a moment before messaging me.');
            setTimeout(() => warn.delete().catch(() => {}), 5000);
            userLastMessageTimestamps.set(userId, now);
            return;
          }
          userLastMessageTimestamps.set(userId, now);

          await message.channel.sendTyping();

      const userMessage = message.content.replace(/<@!?\d+>/g, '').trim();
      const prompt = userMessage || 'Hello!';

      const aiResponse = await callOpenAI(channelId, displayName, prompt);

      addToHistory(channelId, displayName, prompt, false);
      
      // Check if response contains image generation request
      if (aiResponse.includes('IMAGE_GENERATION:')) {
        const imageMatch = aiResponse.match(/IMAGE_GENERATION:\s*(.+)/);
        if (imageMatch) {
          const imageDescription = imageMatch[1].trim();
          
          // Check cooldown first
          const cooldownCheck = checkImageGenerationCooldown(userId);
          if (!cooldownCheck.allowed) {
            const timeStr = formatTimeRemaining(cooldownCheck.timeRemaining);
            const limitMessage = `-# It seems like you tried to generate an image, but you've reached your limit of 2 images/30m! try again in ${timeStr}`;
            addToHistory(channelId, 'Bot', limitMessage, true);
            await message.reply(limitMessage);
            return;
          }
          
          // Generate image
          try {
            const imageUrl = await generateImage(imageDescription);
            // Record this generation in database
            recordImageGeneration(userId);
            addToHistory(channelId, 'Bot', `[Generated image: ${imageDescription}]`, true);
            await message.reply({ content: `here:`, files: [imageUrl] });
          } catch (imageErr) {
            console.error('Image generation error:', imageErr);
            const errorResponse = 'couldn\'t generate that one';
            addToHistory(channelId, 'Bot', errorResponse, true);
            await message.reply(errorResponse);
          }
        }
      } else {
        addToHistory(channelId, 'Bot', aiResponse, true);
        await message.reply(aiResponse);
      }
    } catch (err) {
      console.error('Error:', err);
      await message.reply('Sorry, I encountered an error while processing your request.');
    }
  }
});

client.login(DISCORD_TOKEN);

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'work') {
    const userId = interaction.user.id;
    const username = interaction.user.username;
    const now = Date.now();
    const last = workCooldowns.get(userId) || 0;
    if (now - last < WORK_COOLDOWN_MS) {
      const remaining = Math.ceil((WORK_COOLDOWN_MS - (now - last)) / 1000);
      await interaction.reply({ content: `please wait ${remaining}s before using /work again.`, ephemeral: true });
      return;
    }
    workCooldowns.set(userId, now);
    try {
      ensureUserAsync(userId, username);
      const earned = Math.floor(Math.random() * 51) + 50;
      const newBalance = addCoinsAsync(userId, earned);
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
      ensureUserAsync(userId, username);
      const balance = getCoinsAsync(userId);
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
      const currentPage = interaction.options.getInteger('page') || 1;
      await interaction.reply(buildShopDisplay(currentPage));
      return;
    }

    if (interaction.commandName === 'inventory') {
      const userId = interaction.user.id;
      const username = interaction.user.username;
      try {
        ensureUserAsync(userId, username);
        const invRows = getUserInventory(userId);
        const embed = new EmbedBuilder()
          .setTitle('📦 Inventory')
          .setColor(0x9933ff);

        if (invRows.length === 0) {
          embed.setDescription('you don\'t own any items yet.');
        } else {
          const lines = invRows.map(row => {
            const item = items.find(i => i.id === row.item_id);
            if (!item) return `${row.item_id}: ${row.qty}`;
            return `${item.emoji} **${item.displayname}** — ${row.qty}`;
          });
          embed.setDescription(lines.join('\n'));
        }

        await interaction.reply({ embeds: [embed], ephemeral: false });
      } catch (err) {
        console.error('Inventory error:', err);
        await interaction.reply({ content: 'could not load your inventory.', ephemeral: true });
      }
    }

    if (interaction.commandName === 'use') {
      const itemId = interaction.options.getString('item_id');
      const userId = interaction.user.id;
      const username = interaction.user.username;
      const requestedQty = interaction.options.getInteger('quantity') || 1;

      const useQty = Math.max(1, Math.min(requestedQty, 25));

      if (!itemId) {
        await interaction.reply({ content: 'please provide an item id to use.', ephemeral: true });
        return;
      }

      let item = items.find(x => x.id === itemId);
      if (!item) {
        item = items.find(x => x.aliases && x.aliases.includes(itemId.toLowerCase()));
      }

      if (!item) {
        await interaction.reply({ content: `item '${itemId}' not found.`, ephemeral: true });
        return;
      }

      try {
        ensureUserAsync(userId, username);
        const owned = getItemQty(userId, item.id);
        if (owned <= 0) {
          await interaction.reply({ content: `you don't own any ${item.displayname}.`, ephemeral: true });
          return;
        }

        if (owned < useQty) {
          await interaction.reply({ content: `you only have ${owned}x ${item.displayname}, cannot use ${useQty}.`, ephemeral: true });
          return;
        }

        const funcName = item.function;
        if (!funcName || !itemFunctions[funcName]) {
          await interaction.reply({ content: `${item.displayname} has no function assigned or it is not implemented.`, ephemeral: true });
          return;
        }

        const results = [];
        for (let i = 0; i < useQty; i++) {
          const res = await itemFunctions[funcName]({ userId, item });
          if (!res || !res.success) {
            await interaction.reply({ content: res?.message || `could not use ${item.displayname}.`, ephemeral: true });
            return;
          }
          results.push(res);
        }

        removeItemFromInventory(userId, item.id, useQty);

        const combined = results.map(r => r.message || '').filter(Boolean).join(' | ');
        await interaction.reply({ content: `${item.emoji} ${combined || `used ${useQty}x ${item.displayname}`}`, ephemeral: true });
      } catch (err) {
        console.error('Use command error:', err);
        await interaction.reply({ content: 'error while using item.', ephemeral: true });
      }
      return;
    }
    return;
  }

  if (interaction.isButton()) {
    const custom = interaction.customId || '';
    
    if (custom.startsWith('shop_next:') || custom.startsWith('shop_prev:')) {
      const parts = custom.split(':');
      const nextPage = parseInt(parts[1]);
      if (!isNaN(nextPage)) {
        await interaction.update(buildShopDisplay(nextPage));
        return;
      }
    }

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
      ensureUserAsync(userId, username);
      
      // Use transaction for purchase safety
      try {
        db.exec('BEGIN TRANSACTION');
        
        const result = trySubtractCoinsAsync(userId, item.cost);
        if (!result.success) {
          db.exec('ROLLBACK');
          await interaction.reply({ content: `you need ${item.cost} coins but only have ${result.balance}.`, ephemeral: true });
          return;
        }

        addItemToInventory(userId, itemId, 1);
        db.exec('COMMIT');

        const confirm = new EmbedBuilder()
          .setTitle('✅ Purchase complete')
          .setDescription(`${item.emoji} **${item.displayname}** purchased for **${item.cost}** coins.`)
          .addFields({ name: 'balance', value: `${result.balance} coins`, inline: true })
          .setColor(0x00cc66)
          .setFooter({ text: `bought by ${username}` });

        await interaction.reply({ embeds: [confirm], ephemeral: true });
      } catch (err) {
        console.error('Purchase transaction error:', err);
        try { db.exec('ROLLBACK'); } catch (e2) {}
        await interaction.reply({ content: 'could not complete purchase.', ephemeral: true });
      }
    } catch (err) {
      console.error('Purchase error:', err);
      await interaction.reply({ content: 'could not complete purchase.', ephemeral: true });
    }
    return;
  }
  }
);