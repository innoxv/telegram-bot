const { Telegraf } = require('telegraf');
require('dotenv').config();

// Check if TELEGRAM_BOT_TOKEN is set
if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error('Error: TELEGRAM_BOT_TOKEN is not set in .env file');
    process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Handle /start command with greeting
bot.start((ctx) => {
    const userName = ctx.from.first_name || 'User';
    ctx.reply(`Hello, ${userName}! Welcome to my POS & E-commerce bot. Use /help to see what I can do!`, {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'View Products', callback_data: 'products' }],
                [{ text: 'Help', callback_data: 'help' }],
            ],
        },
    });
});

// Handle /help command
bot.help((ctx) => {
    ctx.reply('Available commands:\n/start - Greet and start the bot\n/help - Show this help message\n/products - List available products\n/cart - View your cart\n/add <product_id> <quantity> - Add items to cart');
});

// Handle button clicks
bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data === 'products') {
        await ctx.reply('Fetching products...');
        ctx.telegraf.command('products', ctx);
    } else if (data === 'help') {
        ctx.telegraf.command('help', ctx);
    }
    await ctx.answerCbQuery();
});

// Handle /products command (temporary in-memory data)
bot.command('products', (ctx) => {
    const products = [
        { id: 1, name: 'T-Shirt', price: 19.99 },
        { id: 2, name: 'Mug', price: 9.99 },
        { id: 3, name: 'Hat', price: 14.99 },
    ];
    let response = 'Available Products:\n';
    products.forEach(product => {
        response += `${product.id}. ${product.name} - $${product.price}\n`;
    });
    response += 'To add to cart, use /add <product_id> <quantity>';
    ctx.reply(response);
});

// Handle /add command
bot.command('add', (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const productId = parseInt(args[0]);
    const quantity = parseInt(args[1]);

    if (!productId || !quantity) {
        return ctx.reply('Usage: /add <product_id> <quantity>');
    }

    const products = [
        { id: 1, name: 'T-Shirt', price: 19.99 },
        { id: 2, name: 'Mug', price: 9.99 },
        { id: 3, name: 'Hat', price: 14.99 },
    ];
    const product = products.find(p => p.id === productId);
    if (!product) {
        return ctx.reply('Product not found!');
    }

    ctx.reply(`Added ${quantity} ${product.name}(s) to your cart.`);
});

// Handle /cart command
bot.command('cart', (ctx) => {
    ctx.reply('Your cart is empty. Use /add to add items.');
});

// Start the bot
bot.launch()
    .then(() => console.log('Bot is running...'))
    .catch((err) => console.error('Failed to start bot:', err));

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));