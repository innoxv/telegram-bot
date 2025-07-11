// Import required modules
const { Telegraf, session, Scenes, Composer } = require('telegraf'); // Telegraf with Scenes for multi-step sign-in
const mysql = require('mysql2/promise'); // MySQL/MariaDB client with promise support
const bcrypt = require('bcrypt'); // Library for password hash verification
require('dotenv').config(); // Load environment variables from .env file

// Validate TELEGRAM_BOT_TOKEN to ensure it's set
if (!process.env.TELEGRAM_BOT_TOKEN) {
    process.exit(1); // Exit if token is missing
}

// Initialize Telegraf bot with the Telegram bot token from .env
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Add session middleware to store user_id and name in memory
bot.use(session()); // Enables in-memory session for tracking signed-in users

// Initialize MySQL/MariaDB connection pool with configuration from .env
const pool = mysql.createPool({
    user: process.env.DB_USER, // Database username
    host: process.env.DB_HOST, // Database host 
    database: process.env.DB_NAME, // Database name 
    password: process.env.DB_PASSWORD, // Database password
    port: process.env.DB_PORT, // Database port 
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
    { command: 'signout', description: 'Sign out to clear your session' },
    { command: 'stop', description: 'Cancel the current process or wizard' } 
]);

// Create a WizardScene for the sign-in process with explicit steps
const signInScene = new Scenes.WizardScene(
    'SIGN_IN_SCENE',
    // Step 1: Always prompt for email
    async (ctx) => {
        // Handle /stop at any point in the wizard
        if (ctx.message?.text?.toLowerCase() === '/stop') {
            if (ctx.scene && ctx.scene.current) {
                await ctx.scene.leave();
            }
            if (ctx.session) {
                delete ctx.session.signInData;
            }
            await ctx.reply('Process cancelled. You can start again anytime.');
            return;
        }
        let email = ctx.message?.text?.trim();
        // If the message is /signin, prompt for email
        if (!email || email.toLowerCase() === '/signin') {
            await ctx.reply('Please enter your email address.', { reply_markup: { force_reply: true } });
            return; // Wait for the next message
        }
        if (!email.includes('@') || !email.includes('.')) {
            await ctx.reply('Please provide a valid email address.', { reply_markup: { force_reply: true } });
            return; // Stay in this step until a valid email is provided
        }
        try {
            // Check if email exists in users table
            const [userRows] = await pool.query('SELECT user_id, password FROM users WHERE email = ?', [email]);
            if (userRows.length === 0) {
                await ctx.reply('No user found with this email. Please contact support.');
                return ctx.scene.leave(); // Exit scene
            }
            const hashedPassword = userRows[0].password;
            if (!hashedPassword || !hashedPassword.startsWith('$2')) {
                await ctx.reply('Invalid password hash format in database. Please contact support.');
                return ctx.scene.leave(); // Exit scene
            }
            ctx.session = ctx.session || {};
            ctx.session.signInData = { email, userId: userRows[0].user_id, hashedPassword };
            await ctx.reply('Please enter your password.', { reply_markup: { force_reply: true } });
            return ctx.wizard.next(); // Move to password step
        } catch (err) {
            await ctx.reply('Error processing email. Please try again later.');
            return ctx.scene.leave(); // Exit scene on error
        }
    },
    // Step 2: Handle password input
    async (ctx) => {
        // Handle /stop at any point in the wizard
        if (ctx.message?.text?.toLowerCase() === '/stop') {
            if (ctx.scene && ctx.scene.current) {
                await ctx.scene.leave();
            }
            if (ctx.session) {
                delete ctx.session.signInData;
            }
            await ctx.reply('Process cancelled. You can start again anytime.');
            return;
        }
        if (!ctx.message?.text) {
            await ctx.reply('Please send a text password.');
            return ctx.scene.leave(); // Exit scene if non-text input
        }
        const password = ctx.message.text.trim(); // Get password and remove whitespace
        const { email, userId, hashedPassword } = ctx.session?.signInData || {};

        if (!userId || !hashedPassword) {
            await ctx.reply('Session expired. Please start over with /signin <email>.');
            return ctx.scene.leave(); // Exit scene if session data is missing
        }

        try {
            // Verify password against hashed password
            const safeHash = hashedPassword.replace(/^\$2y\$/, '$2b$'); // Replace $2y$ with $2b$ to match bcrypt format since the passwords were hashed with $2y$ in PHP
            const isPasswordValid = await bcrypt.compare(password, safeHash);
            if (!isPasswordValid) {
                await ctx.reply('Invalid password. Please try again with /signin.');
                delete ctx.session.signInData; // Clear temporary data
                return ctx.scene.leave(); // Exit scene
            }

            // Get customer name from customers table
            const [customerRows] = await pool.query('SELECT name FROM customers WHERE user_id = ?', [userId]);
            if (customerRows.length === 0) {
                await ctx.reply('No customer account linked. Please contact support.');
                delete ctx.session.signInData; // Clear temporary data
                return ctx.scene.leave(); // Exit scene
            }
            const customerName = customerRows[0].name;

            // Store user_id and name in session
            ctx.session.userId = userId;
            ctx.session.customerName = customerName;

            // Clear temporary sign-in data
            delete ctx.session.signInData;

            // Reply with customer name and inline keyboard
            await ctx.reply(`Sign-in successful, ${customerName}! You can now use the bot commands.`, {
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
            return ctx.scene.leave(); // Exit scene
        } catch (err) {
            await ctx.reply(`Error signing in: ${err.message}. Please try again later.`);
            delete ctx.session.signInData; // Clear temporary data
            return ctx.scene.leave(); // Exit scene
        }
    }
);

// Create and register the Scenes stage
const stage = new Scenes.Stage([signInScene]);
bot.use(stage.middleware());

// Handle /signin command to enter the sign-in scene, ensuring clean session
bot.command('signin', async (ctx) => {
    // Clear any existing sign-in session data to prevent overlap
    if (ctx.session) {
        delete ctx.session.signInData;
    }
    ctx.scene.enter('SIGN_IN_SCENE'); // Enter the sign-in scene
});

// Handle /start command to greet user and provide interaction options
bot.start(async (ctx) => {
    const userName = ctx.session?.customerName || ctx.from.first_name || 'User'; // Use customer name if signed in
    const telegramId = ctx.from.id; // Get user's Telegram ID

    try {
        // Check if user is signed in (session contains user_id)
        if (!ctx.session || !ctx.session.userId) {
            ctx.reply(`Hello, ${userName}! Welcome to the Lending Management Bot. Use /signin to link your account.`);
            return;
        }
    } catch (err) {
        ctx.reply('Error connecting to the database. Please try again later.'); // Handle database errors
    }
});

// Handle /help command to display available commands
bot.help((ctx) => {
    ctx.reply('Available commands:\n' +
        '/start - Greet and start the bot\n' +
        '/help - Show this help message\n' +
        '/checkloan - Check the status of a specific loan\n' +
        '/balance - View your outstanding loan balance\n' +
        '/loans - List all your loans\n' +
        '/signin - Sign in with your email to link your account\n' +
        '/signout - Sign out to clear your session\n' +
        '/stop - Cancel the current process or wizard');
});

// Handle /signout command to clear the user's session
bot.command('signout', async (ctx) => {
    // Clear the session to sign out the user
    ctx.session = null; // Destroy session data
    ctx.reply('You have signed out successfully. Use /signin to sign in again.');
});

// Handle /checkloan command to prompt for loan ID
bot.command('checkloan', async (ctx) => {
    // Check if user is signed in before prompting for loan ID
    if (!ctx.session || !ctx.session.userId) {
        return ctx.reply('You are not signed in. Use /signin to link your account.');
    }
    // Prompt for loan ID
    await ctx.reply('Please enter the loan ID you want to check:', { reply_markup: { force_reply: true } });
});

// Handle reply to the forced reply for loan ID
bot.on('message', async (ctx) => {
    // Only handle if this is a reply to the checkloan prompt
    if (ctx.message?.reply_to_message?.text?.startsWith('Please enter the loan ID')) {
        const loanId = parseInt(ctx.message.text.trim());
        if (isNaN(loanId)) {
            return ctx.reply('Please provide a valid loan ID (number).');
        }
        try {
            if (!ctx.session || !ctx.session.userId) {
                return ctx.reply('You are not signed in. Use /signin to link your account.');
            }
            const userId = ctx.session.userId;
            const [customerRows] = await pool.query('SELECT customer_id FROM customers WHERE user_id = ?', [userId]);
            if (customerRows.length === 0) {
                return ctx.reply('No customer account linked. Please contact support.');
            }
            const customerId = customerRows[0].customer_id;
            const [loanRows] = await pool.query(
                'SELECT loan_id, amount, interest_rate, status, due_date, application_date FROM loans WHERE loan_id = ? AND customer_id = ?',
                [loanId, customerId]
            );
            if (loanRows.length === 0) {
                return ctx.reply('Loan not found or you do not have access to this loan.');
            }
            const loan = loanRows[0];
            ctx.reply(`Loan ID: ${loan.loan_id}\n` +
                `Amount: ${loan.amount}\n` +
                `Interest Rate: ${loan.interest_rate}%\n` +
                `Status: ${loan.status}\n` +
                `Due Date: ${loan.due_date || 'Not set'}\n` +
                `Application Date: ${loan.application_date}`);
        } catch (err) {
            ctx.reply('Error fetching loan details. Please try again later.');
        }
    }
});

// Handle /balance command to calculate outstanding loan balance
bot.command('balance', async (ctx) => {
    const telegramId = ctx.from.id; // Get user's Telegram ID

    try {
        // Check if user is signed in
        if (!ctx.session || !ctx.session.userId) {
            return ctx.reply('You are not signed in. Use /signin to link your account.');
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
            return ctx.reply('You are not signed in. Use /signin to link your account.');
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
        // Check if user is signed in before prompting for loan ID
        if (!ctx.session || !ctx.session.userId) {
            return ctx.reply('You are not signed in. Use /signin to link your account.');
        }
        // Prompt for loan ID 
        await ctx.reply('Please enter the loan ID you want to check:', { reply_markup: { force_reply: true } });
    } else if (data === 'balance') {
        try {
            // Check if user is signed in
            if (!ctx.session || !ctx.session.userId) {
                return ctx.reply('You are not signed in. Use /signin to link your account.');
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
                return ctx.reply('You are not signed in. Use /signin to link your account.');
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
            '/checkloan - Check the status of a specific loan\n' +
            '/balance - View your outstanding loan balance\n' +
            '/loans - List all your loans\n' +
            '/signin - Sign in with your email to link your account\n' +
            '/signout - Sign out to clear your session\n' +
            '/stop - Cancel the current process or wizard');
    }
    await ctx.answerCbQuery(); // Acknowledge callback query
});

// Handle /stop command to cancel any ongoing process or wizard
bot.command('stop', async (ctx) => {
    // Leave any active scene (including email/password input)
    if (ctx.scene && ctx.scene.current) {
        await ctx.scene.leave();
    }
    // Clear any sign-in data or other temp session data
    if (ctx.session) {
        delete ctx.session.signInData;
    }
    await ctx.reply('Process cancelled. You can start again anytime.');
});


// Start the bot and handle graceful shutdown
bot.launch()
    .catch(() => {
        // Silently handle bot start errors
    });
process.once('SIGINT', () => bot.stop('SIGINT')); // Handle interrupt signal
process.once('SIGTERM', () => bot.stop('SIGTERM')); // Handle termination signal
