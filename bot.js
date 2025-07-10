// Import required modules
const { Telegraf, session } = require('telegraf'); // Telegraf library for Telegram bot with session middleware
const mysql = require('mysql2/promise'); // MySQL/MariaDB client with promise support
require('dotenv').config(); // Load environment variables from .env file

// Validate TELEGRAM_BOT_TOKEN to ensure it's set
if (!process.env.TELEGRAM_BOT_TOKEN) {
    process.exit(1); // Exit if token is missing
}

// Initialize Telegraf bot with the Telegram bot token from .env
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Add session middleware to store user_id in memory
bot.use(session()); // Enables in-memory session for tracking signed-in users

// Initialize MySQL/MariaDB connection pool with configuration from .env
const pool = mysql.createPool({
    user: process.env.DB_USER, // Database username
    host: process.env.DB_HOST, // Database host (e.g., localhost)
    database: process.env.DB_NAME, // Database name (LMSDB)
    password: process.env.DB_PASSWORD, // Database password
    port: process.env.DB_PORT, // Database port (e.g., 3306)
    waitForConnections: true, // Wait for available connections
    connectionLimit: 10, // Maximum number of connections
    queueLimit: 0 // Unlimited queued connection requests
});

// Test database connection on startup to ensure connectivity
pool.getConnection()
    .catch(() => {
        process.exit(1); // Exit if connection fails
    });

// Set up Telegram bot command menu with exact descriptions
bot.telegram.setMyCommands([
    { command: 'start', description: 'Greet and start the bot' },
    { command: 'help', description: 'Show this help message' },
    { command: 'checkloan', description: 'Check the status of a specific loan' },
    { command: 'balance', description: 'View your outstanding loan balance' },
    { command: 'loans', description: 'List all your loans' },
    { command: 'signin', description: 'Sign in with your email to link your account' },
    { command: 'signout', description: 'Sign out to clear your session' }
]);

// Handle /start command to greet user and provide interaction options
bot.start(async (ctx) => {
    const userName = ctx.from.first_name || 'User'; // Get user's first name or default to 'User'
    const telegramId = ctx.from.id; // Get user's Telegram ID

    try {
        // Check if user is signed in (session contains user_id)
        if (!ctx.session || !ctx.session.userId) {
            ctx.reply(`Hello, ${userName}! It seems you're not signed in. Use /signin <email> to link your account.`);
            return;
        }

        // Send welcome message with inline keyboard
        ctx.reply(`Hello, ${userName}! Welcome to the Lending Management Bot. Use /help to see what I can do!`, {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: 'Check Loan Status', callback_data: 'checkloan' },
                        { text: 'View Balance', callback_data: 'balance' }
                    ],
                    [
                        { text: 'List Loans', callback_data: 'loans' },
                        { text: 'Help', callback_data: 'help' }
                    ]
                ]
            }
        });
    } catch (err) {
        ctx.reply('Error connecting to the database. Please try again later.'); // Handle database errors
    }
});

// Handle /help command to display available commands
bot.help((ctx) => {
    ctx.reply('Available commands:\n' +
        '/start - Greet and start the bot\n' +
        '/help - Show this help message\n' +
        '/checkloan <loan_id> - Check the status of a specific loan\n' +
        '/balance - View your outstanding loan balance\n' +
        '/loans - List all your loans\n' +
        '/signin <email> - Sign in with your email to link your account\n' +
        '/signout - Sign out to clear your session');
});

// Handle /signin command to link Telegram ID to a user account in memory
bot.command('signin', async (ctx) => {
    const telegramId = ctx.from.id; // Get user's Telegram ID
    const args = ctx.message.text.split(' ').slice(1); // Extract command arguments

    if (args.length !== 1) {
        return ctx.reply('Usage: /signin <email>'); // Validate input
    }
    const email = args[0]; // Get email from arguments

    // Basic email validation
    if (!email.includes('@') || !email.includes('.')) {
        return ctx.reply('Please provide a valid email address.');
    }

    try {
        // Check if email exists in users table
        const [userRows] = await pool.query('SELECT user_id FROM users WHERE email = ?', [email]);
        if (userRows.length === 0) {
            return ctx.reply('No user found with this email. Please contact support.');
        }
        const userId = userRows[0].user_id; // Retrieve user_id

        // Store user_id in session to track signed-in user
        ctx.session = ctx.session || {}; // Initialize session if undefined
        ctx.session.userId = userId; // Set user_id in session
        ctx.reply('Sign-in successful! You can now use the bot commands.', {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: 'View Balance', callback_data: 'balance' },
                        { text: 'List Loans', callback_data: 'loans' }
                    ]
                ]
            }
        });
    } catch (err) {
        ctx.reply('Error signing in. Please try again later.'); // Handle errors
    }
});

// Handle /signout command to clear the user's session
bot.command('signout', async (ctx) => {
    // Clear the session to sign out the user
    ctx.session = null; // Destroy session data
    ctx.reply('You have signed out successfully. Use /signin <email> to sign in again.');
});

// Handle /checkloan command to retrieve details of a specific loan
bot.command('checkloan', async (ctx) => {
    const telegramId = ctx.from.id; // Get user's Telegram ID
    const args = ctx.message.text.split(' ').slice(1); // Extract loan_id

    if (args.length !== 1) {
        return ctx.reply('Usage: /checkloan <loan_id>'); // Validate input
    }
    const loanId = parseInt(args[0]); // Parse loan_id as integer
    if (isNaN(loanId)) {
        return ctx.reply('Please provide a valid loan ID.');
    }

    try {
        // Check if user is signed in
        if (!ctx.session || !ctx.session.userId) {
            return ctx.reply('You are not signed in. Use /signin <email> to link your account.');
        }
        const userId = ctx.session.userId; // Get user_id from session

        // Get customer_id from customers table
        const [customerRows] = await pool.query('SELECT customer_id FROM customers WHERE user_id = ?', [userId]);
        if (customerRows.length === 0) {
            return ctx.reply('No customer account linked. Please contact support.');
        }
        const customerId = customerRows[0].customer_id;

        // Get loan details
        const [loanRows] = await pool.query(
            'SELECT loan_id, amount, interest_rate, status, due_date, application_date FROM loans WHERE loan_id = ? AND customer_id = ?',
            [loanId, customerId]
        );
        if (loanRows.length === 0) {
            return ctx.reply('Loan not found or you do not have access to this loan.');
        }

        const loan = loanRows[0]; // Extract loan details
        ctx.reply(`Loan ID: ${loan.loan_id}\n` +
            `Amount: ${loan.amount}\n` +
            `Interest Rate: ${loan.interest_rate}%\n` +
            `Status: ${loan.status}\n` +
            `Due Date: ${loan.due_date || 'Not set'}\n` +
            `Application Date: ${loan.application_date}`);
    } catch (err) {
        ctx.reply('Error fetching loan details. Please try again later.'); // Handle errors
    }
});

// Handle /balance command to calculate outstanding loan balance
bot.command('balance', async (ctx) => {
    const telegramId = ctx.from.id; // Get user's Telegram ID

    try {
        // Check if user is signed in
        if (!ctx.session || !ctx.session.userId) {
            return ctx.reply('You are not signed in. Use /signin <email> to link your account.');
        }
        const userId = ctx.session.userId; // Get user_id from session

        // Get customer_id from customers table
        const [customerRows] = await pool.query('SELECT customer_id FROM customers WHERE user_id = ?', [userId]);
        if (customerRows.length === 0) {
            return ctx.reply('No customer account linked. Please contact support.');
        }
        const customerId = customerRows[0].customer_id;

        // Get sum of remaining balances from latest payments for disbursed loans
        const [balanceRows] = await pool.query(
            `SELECT COALESCE(SUM(latest_payment.remaining_balance), 0) as outstanding_balance
             FROM loans
             JOIN (
                 SELECT loan_id, remaining_balance
                 FROM payments
                 WHERE (loan_id, payment_date) IN (
                     SELECT loan_id, MAX(payment_date)
                     FROM payments
                     GROUP BY loan_id
                 )
             ) latest_payment ON loans.loan_id = latest_payment.loan_id
             WHERE loans.customer_id = ? AND loans.status = 'disbursed'`,
            [customerId]
        );
        const outstandingBalance = parseFloat(balanceRows[0].outstanding_balance) || 0; // Extract balance, default to 0

        ctx.reply(`Your outstanding loan balance: ${outstandingBalance.toFixed(2)}`);
    } catch (err) {
        ctx.reply('Error calculating balance. Please try again later.'); // Handle errors
    }
});

// Handle /loans command to list all loans for the user
bot.command('loans', async (ctx) => {
    const telegramId = ctx.from.id; // Get user's Telegram ID

    try {
        // Check if user is signed in
        if (!ctx.session || !ctx.session.userId) {
            return ctx.reply('You are not signed in. Use /signin <email> to link your account.');
        }
        const userId = ctx.session.userId; // Get user_id from session

        // Get customer_id from customers table
        const [customerRows] = await pool.query('SELECT customer_id FROM customers WHERE user_id = ?', [userId]);
        if (customerRows.length === 0) {
            return ctx.reply('No customer account linked. Please contact support.');
        }
        const customerId = customerRows[0].customer_id;

        // Get all loans for the customer, ordered by application date
        const [loanRows] = await pool.query(
            'SELECT loan_id, amount, status, due_date FROM loans WHERE customer_id = ? ORDER BY application_date DESC',
            [customerId]
        );
        if (loanRows.length === 0) {
            return ctx.reply('You have no loans.');
        }

        let response = 'Your loans:\n';
        loanRows.forEach(loan => {
            response += `Loan ID: ${loan.loan_id}, Amount: ${loan.amount}, Status: ${loan.status}, Due: ${loan.due_date || 'Not set'}\n`;
        });
        ctx.reply(response);
    } catch (err) {
        ctx.reply('Error fetching loans. Please try again later.'); // Handle errors
    }
});

// Handle inline button clicks for interactive menu
bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data; // Get callback data
    const telegramId = ctx.from.id; // Get user's Telegram ID

    if (data === 'checkloan') {
        ctx.reply('Please enter the loan ID using: /checkloan <loan_id>');
    } else if (data === 'balance') {
        try {
            // Check if user is signed in
            if (!ctx.session || !ctx.session.userId) {
                return ctx.reply('You are not signed in. Use /signin <email> to link your account.');
            }
            const userId = ctx.session.userId; // Get user_id from session

            // Get customer_id from customers table
            const [customerRows] = await pool.query('SELECT customer_id FROM customers WHERE user_id = ?', [userId]);
            if (customerRows.length === 0) {
                return ctx.reply('No customer account linked. Please contact support.');
            }
            const customerId = customerRows[0].customer_id;

            // Get sum of remaining balances from latest payments for disbursed loans
            const [balanceRows] = await pool.query(
                `SELECT COALESCE(SUM(latest_payment.remaining_balance), 0) as outstanding_balance
                 FROM loans
                 JOIN (
                     SELECT loan_id, remaining_balance
                     FROM payments
                     WHERE (loan_id, payment_date) IN (
                         SELECT loan_id, MAX(payment_date)
                         FROM payments
                         GROUP BY loan_id
                     )
                 ) latest_payment ON loans.loan_id = latest_payment.loan_id
                 WHERE loans.customer_id = ? AND loans.status = 'disbursed'`,
                [customerId]
            );
            const outstandingBalance = parseFloat(balanceRows[0].outstanding_balance) || 0; // Extract balance, default to 0

            ctx.reply(`Your outstanding loan balance: ${outstandingBalance.toFixed(2)}`);
        } catch (err) {
            ctx.reply('Error calculating balance. Please try again later.'); // Handle errors
        }
    } else if (data === 'loans') {
        try {
            // Check if user is signed in
            if (!ctx.session || !ctx.session.userId) {
                return ctx.reply('You are not signed in. Use /signin <email> to link your account.');
            }
            const userId = ctx.session.userId; // Get user_id from session

            // Get customer_id from customers table
            const [customerRows] = await pool.query('SELECT customer_id FROM customers WHERE user_id = ?', [userId]);
            if (customerRows.length === 0) {
                return ctx.reply('No customer account linked. Please contact support.');
            }
            const customerId = customerRows[0].customer_id;

            // Get all loans for the customer, ordered by application date
            const [loanRows] = await pool.query(
                'SELECT loan_id, amount, status, due_date FROM loans WHERE customer_id = ? ORDER BY application_date DESC',
                [customerId]
            );
            if (loanRows.length === 0) {
                return ctx.reply('You have no loans.');
            }

            let response = 'Your loans:\n';
            loanRows.forEach(loan => {
                response += `Loan ID: ${loan.loan_id}, Amount: ${loan.amount}, Status: ${loan.status}, Due: ${loan.due_date || 'Not set'}\n`;
            });
            ctx.reply(response);
        } catch (err) {
            ctx.reply('Error fetching loans. Please try again later.'); // Handle errors
        }
    } else if (data === 'help') {
        ctx.reply('Available commands:\n' +
            '/start - Greet and start the bot\n' +
            '/help - Show this help message\n' +
            '/checkloan <loan_id> - Check the status of a specific loan\n' +
            '/balance - View your outstanding loan balance\n' +
            '/loans - List all your loans\n' +
            '/signin <email> - Sign in with your email to link your account\n' +
            '/signout - Sign out to clear your session');
    }
    await ctx.answerCbQuery(); // Acknowledge callback query
});

// Start the bot and handle graceful shutdown
bot.launch()
    .catch(() => {
        // Silently handle bot start errors
    });
process.once('SIGINT', () => bot.stop('SIGINT')); // Handle interrupt signal
process.once('SIGTERM', () => bot.stop('SIGTERM')); // Handle termination signal