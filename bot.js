// Import required modules for bot functionality, database interaction, password hashing, and environment variable management
const { Telegraf, session, Scenes } = require('telegraf'); // Telegraf for bot framework, session for in-memory session management, Scenes for multi-step wizards
const mysql = require('mysql2/promise'); // MySQL client with promise support for async database queries
const bcrypt = require('bcrypt'); // Library for secure password hash verification
require('dotenv').config(); // Loads environment variables from .env file

// Validate environment variables to ensure the Telegram bot token is set
if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error('Missing TELEGRAM_BOT_TOKEN'); // Log error if token is missing
    process.exit(1); // Exit process with failure code
}

// Initialize bot and database pool
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN); // Create Telegraf bot instance with token from .env
bot.use(session()); // Enable in-memory session middleware to store user data (userId, customerName)

const pool = mysql.createPool({ // Create MySQL connection pool for efficient database access
    user: process.env.DB_USER, // Database username from .env 
    host: process.env.DB_HOST, // Database host 
    database: process.env.DB_NAME, // Database name 
    password: process.env.DB_PASSWORD, // Database password
    port: process.env.DB_PORT, // Database port 
    waitForConnections: true, // Wait for available connections if pool is busy
    connectionLimit: 10, // Maximum number of simultaneous connections
    queueLimit: 0 // Allow unlimited queued connection requests
});


// Verify database connection to ensure the bot can access LMSDB
pool.getConnection()
    .then(conn => conn.release()) // Acquire and release a connection to test connectivity
    .catch(() => {
        console.error('Database connection failed'); // Log error if connection fails
        process.exit(1); // Exit process with failure code
    });

// Set bot commands in Telegram’s command menu for user interaction
bot.telegram.setMyCommands([
    { command: 'start', description: 'Start the bot' }, // Greets user and shows sign-in prompt if needed
    { command: 'help', description: 'Show help' }, // Lists available commands
    { command: 'checkloan', description: 'Check loan status' }, // Prompts for loan ID to check details
    { command: 'balance', description: 'View loan balance' }, // Shows total outstanding loan balance
    { command: 'loans', description: 'List all loans' }, // Lists all user loans
    { command: 'signin', description: 'Sign in' }, // Initiates sign-in process
    { command: 'signout', description: 'Sign out' }, // Clears user session
    { command: 'stop', description: 'Cancel current process' } // Cancels ongoing wizard or process
]);

// Helper function to check if user is authenticated
function checkAuth(ctx) {
    if (!ctx.session?.userId) { // Check if session exists and has userId
        ctx.reply('You are not signed in. Use /signin to link your account.'); // Reply if not signed in
        return false; // Return false to indicate unauthenticated state
    }
    return true; // Return true if user is authenticated
}

// Helper function to retrieve customer ID from database
async function getCustomerId(userId) {
    const [customerRows] = await pool.query('SELECT customer_id FROM customers WHERE user_id = ?', [userId]); // Query customers table for customer_id
    return customerRows.length > 0 ? customerRows[0].customer_id : null; // Return customer_id or null if not found
}

// Sign-in Wizard Scene for multi-step authentication
const signInScene = new Scenes.WizardScene(
    'SIGN_IN_SCENE', // Scene identifier
    // Step 1: Handle email input
    async (ctx) => {
        if (ctx.message?.text?.toLowerCase() === '/stop') { // Check for /stop command to cancel process
            await ctx.scene.leave(); // Exit the scene
            delete ctx.session?.signInData; // Clear temporary sign-in data
            return ctx.reply('Process cancelled.'); // Reply to confirm cancellation
        }

        const email = ctx.message?.text?.trim(); // Get and trim email input
        if (!email || email.toLowerCase() === '/signin') { // Check if email is missing or command is /signin
            return ctx.reply('Please enter your email:', { reply_markup: { force_reply: true } }); // Prompt for email with forced reply
        }

        if (!email.includes('@') || !email.includes('.')) { // Validate email format
            return ctx.reply('Invalid email format. Please try again:', { reply_markup: { force_reply: true } }); // Prompt again if invalid
        }

        try {
            const [userRows] = await pool.query('SELECT user_id, password FROM users WHERE email = ?', [email]); // Query users table for email
            if (userRows.length === 0) { // Check if user exists
                await ctx.reply('Email not found. Contact support.'); // Reply if no user found
                return ctx.scene.leave(); // Exit scene
            }

            const hashedPassword = userRows[0].password; // Get hashed password
            if (!hashedPassword?.startsWith('$2')) { // Validate hash format
                await ctx.reply('System error. Contact support.'); // Reply if hash is invalid
                return ctx.scene.leave(); // Exit scene
            }

            ctx.session = ctx.session || {}; // Initialize session if undefined
            ctx.session.signInData = { // Store temporary sign-in data
                email,
                userId: userRows[0].user_id,
                hashedPassword
            };

            await ctx.reply('Please enter your password:', { reply_markup: { force_reply: true } }); // Prompt for password
            return ctx.wizard.next(); // Move to password step
        } catch (err) {
            console.error('Email verification error:', err); // Log error
            await ctx.reply('System error. Try again later.'); // Reply on error
            return ctx.scene.leave(); // Exit scene
        }
    },
    // Step 2: Handle password input
    async (ctx) => {
        if (ctx.message?.text?.toLowerCase() === '/stop') { // Check for /stop command
            await ctx.scene.leave(); // Exit the scene
            delete ctx.session?.signInData; // Clear temporary sign-in data
            return ctx.reply('Process cancelled.'); // Reply to confirm cancellation
        }

        if (!ctx.message?.text) { // Check if input is text
            await ctx.reply('Invalid input. Please enter your password:'); // Reply if non-text input
            return;
        }

        const password = ctx.message.text.trim(); // Get and trim password input
        const { email, userId, hashedPassword } = ctx.session?.signInData || {}; // Retrieve sign-in data

        if (!userId || !hashedPassword) { // Check if session data is present
            await ctx.reply('Session expired. Please start over.'); // Reply if session expired
            return ctx.scene.leave(); // Exit scene
        }

        try {
            const safeHash = hashedPassword.replace(/^\$2y\$/, '$2b$'); // Convert PHP bcrypt hash ($2y$) to node-bcrypt ($2b$)
            const isValid = await bcrypt.compare(password, safeHash); // Verify password against hash
            
            if (!isValid) { // Check if password is valid
                await ctx.reply('Invalid password. Use /signin to try again.'); // Reply if password is incorrect
                delete ctx.session.signInData; // Clear temporary data
                return ctx.scene.leave(); // Exit scene
            }

            const [customerRows] = await pool.query('SELECT customer_id, name FROM customers WHERE user_id = ?', [userId]); // Query customer data
            if (customerRows.length === 0) { // Check if customer exists
                await ctx.reply('Account not found. Contact support.'); // Reply if no customer found
                delete ctx.session.signInData; // Clear temporary data
                return ctx.scene.leave(); // Exit scene
            }

            ctx.session.userId = userId; // Store user ID in session
            ctx.session.customerId = customerRows[0].customer_id; // Store customer ID
            ctx.session.customerName = customerRows[0].name; // Store customer name
            delete ctx.session.signInData; // Clear temporary sign-in data

            await ctx.reply(`Welcome back, ${ctx.session.customerName}!`, { // Reply with welcome message and inline keyboard
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: 'Check Loan', callback_data: 'checkloan' },
                            { text: 'View Balance', callback_data: 'balance' }
                        ],
                        [
                            { text: 'List Loans', callback_data: 'loans' },
                            { text: 'Help', callback_data: 'help' }
                        ]
                    ]
                }
            });

            return ctx.scene.leave(); // Exit scene on successful sign-in
        } catch (err) {
            console.error('Password verification error:', err); // Log error
            await ctx.reply('System error. Try again later.'); // Reply on error
            return ctx.scene.leave(); // Exit scene
        }
    }
);

// Register the sign-in scene
const stage = new Scenes.Stage([signInScene]); // Create stage for managing scenes
bot.use(stage.middleware()); // Apply scene middleware to bot

// Handle /signin command to initiate sign-in process
bot.command('signin', async (ctx) => {
    delete ctx.session?.signInData; // Clear any existing sign-in data to prevent overlap
    await ctx.scene.enter('SIGN_IN_SCENE'); // Enter the sign-in wizard
});

// Handle /start command to greet user
bot.command('start', async (ctx) => {
    const name = ctx.session?.customerName || ctx.from.first_name || 'User'; // Use customer name if signed in, else Telegram first name or 'User'
    await ctx.reply(`Hello ${name}! ${ctx.session?.userId ? '' : 'Use /signin to access your account.'}`); // Reply with greeting, prompting sign-in if needed
});

// Handle /help command to list available commands
bot.command('help', (ctx) => {
    ctx.reply([ // Reply with formatted list of commands
        'Available commands:',
        '/start - Start the bot',
        '/help - Show help',
        '/checkloan - Check loan status',
        '/balance - View loan balance',
        '/loans - List all loans',
        '/signin - Sign in',
        '/signout - Sign out',
        '/stop - Cancel current process'
    ].join('\n'));
});

// Handle /signout command to clear user session
bot.command('signout', async (ctx) => {
    ctx.session = null; // Clear all session data
    await ctx.reply('Signed out successfully. Use /signin to access your account.'); // Reply to confirm sign-out
});

// Handle /checkloan command to prompt for loan ID
bot.command('checkloan', async (ctx) => {
    if (!checkAuth(ctx)) return; // Check if user is signed in, reply if not
    await ctx.reply('Enter loan ID to check:', { reply_markup: { force_reply: true } }); // Prompt for loan ID with forced reply
});

// Handle /balance command to calculate outstanding loan balance
bot.command('balance', async (ctx) => {
    if (!checkAuth(ctx)) return; // Check if user is signed in, reply with "You are not signed in" if not
    
    try {
        const customerId = await getCustomerId(ctx.session.userId); // Retrieve customer ID from database
        if (!customerId) { // Check if customer ID exists
            return ctx.reply('No customer account linked. Please contact support.'); // Reply if no customer found
        }

        // Query to calculate total remaining balance for disbursed loans
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

        const outstandingBalance = parseFloat(balanceRows[0].outstanding_balance) || 0; // Extract balance, default to 0 if null
        await ctx.reply(`Your outstanding loan balance: ${outstandingBalance.toFixed(2)}`); // Reply with formatted balance
    } catch (err) {
        console.error('Balance error:', err); // Log error for debugging
        await ctx.reply('Error calculating balance. Try again later.'); // Reply on error
    }
});

// Handle /loans command to list all loans for the user
bot.command('loans', async (ctx) => {
    if (!checkAuth(ctx)) return; // Check if user is signed in, reply with "You are not signed in" if not
    
    try {
        const customerId = await getCustomerId(ctx.session.userId); // Retrieve customer ID from database
        if (!customerId) { // Check if customer ID exists
            return ctx.reply('No customer account linked. Please contact support.'); // Reply if no customer found
        }

        // Query all loans for the customer, ordered by application date
        const [loans] = await pool.query(
            'SELECT loan_id, amount, status, due_date FROM loans WHERE customer_id = ? ORDER BY application_date DESC',
            [customerId]
        );

        if (loans.length === 0) { // Check if any loans exist
            return ctx.reply('No loans found.'); // Reply if no loans found
        }

        // Format loan data into a readable string
        const response = loans.map(loan => 
            `ID: ${loan.loan_id}\nAmount: ${loan.amount}\nStatus: ${loan.status}\nDue: ${loan.due_date || 'N/A'}`
        ).join('\n\n');

        await ctx.reply(`Your loans:\n\n${response}`); // Reply with formatted loan list
    } catch (err) {
        console.error('Loans error:', err); // Log error for debugging
        await ctx.reply('Error fetching loans. Try again later.'); // Reply on error
    }
});

// Handle loan ID replies for /checkloan
bot.on('message', async (ctx) => {
    if (!ctx.message?.reply_to_message?.text?.startsWith('Enter loan ID')) return; // Only process replies to loan ID prompt
    if (!checkAuth(ctx)) return; // Check if user is signed in, reply with "You are not signed in" if not

    const loanId = parseInt(ctx.message.text.trim()); // Parse loan ID from message
    if (isNaN(loanId)) { // Validate loan ID is a number
        return ctx.reply('Invalid loan ID. Please enter a number.'); // Reply if invalid
    }

    try {
        const customerId = await getCustomerId(ctx.session.userId); // Retrieve customer ID
        if (!customerId) { // Check if customer ID exists
            return ctx.reply('No customer account linked. Please contact support.'); // Reply if no customer found
        }

        // Query loan details for the specified loan ID and customer
        const [loans] = await pool.query(
            'SELECT amount, interest_rate, status, due_date, application_date FROM loans WHERE loan_id = ? AND customer_id = ?',
            [loanId, customerId]
        );

        if (loans.length === 0) { // Check if loan exists
            return ctx.reply('Loan not found or access denied.'); // Reply if no loan found
        }

        const loan = loans[0]; // Get loan data
        await ctx.reply([ // Reply with formatted loan details
            `Loan ID: ${loanId}`,
            `Amount: ${loan.amount}`,
            `Interest Rate: ${loan.interest_rate}%`,
            `Status: ${loan.status}`,
            `Due Date: ${loan.due_date || 'N/A'}`,
            `Applied: ${loan.application_date}`
        ].join('\n'));
    } catch (err) {
        console.error('Loan check error:', err); // Log error
        await ctx.reply('Error checking loan. Try again later.'); // Reply on error
    }
});

// Inline button handlers for interactive menu
bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data; // Get callback data from button click
    
    try {
        if (!ctx.session?.userId) { // Check if user is signed in
            await ctx.answerCbQuery('Please sign in first'); // Notify via callback if not signed in
            return;
        }

        const customerId = await getCustomerId(ctx.session.userId); // Retrieve customer ID
        if (!customerId) { // Check if customer ID exists
            await ctx.answerCbQuery('Account not found'); // Notify via callback if no customer
            return;
        }

        if (data === 'checkloan') { // Handle Check Loan button
            await ctx.answerCbQuery(); // Acknowledge callback
            await ctx.reply('Enter loan ID to check:', { // Prompt for loan ID
                reply_markup: { force_reply: true } 
            });
        }
        else if (data === 'balance') { // Handle View Balance button
            // Query total remaining balance for disbursed loans
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
            
            await ctx.answerCbQuery(); // Acknowledge callback
            await ctx.reply(`Your outstanding loan balance: ${outstandingBalance.toFixed(2)}`); // Reply with balance
        }
        else if (data === 'loans') { // Handle List Loans button
            // Query loans with limit to prevent large responses
            const [loans] = await pool.query(
                'SELECT loan_id, amount, status FROM loans WHERE customer_id = ? ORDER BY application_date DESC LIMIT 10',
                [customerId]
            );

            await ctx.answerCbQuery(); // Acknowledge callback
            if (loans.length === 0) { // Check if any loans exist
                await ctx.reply('No loans found.'); // Reply if no loans
            } else {
                const response = loans.map(loan => // Format loan data
                    `ID: ${loan.loan_id} | Amount: ${loan.amount} | Status: ${loan.status}`
                ).join('\n');
                await ctx.reply(`Your loans:\n\n${response}`); // Reply with loan list
            }
        }
        else if (data === 'help') { // Handle Help button
            await ctx.answerCbQuery(); // Acknowledge callback
            await ctx.reply( // Reply with command list
                'Available commands:\n' +
                '/start - Start the bot\n' +
                '/help - Show help\n' +
                '/checkloan - Check loan status\n' +
                '/balance - View loan balance\n' +
                '/loans - List all loans\n' +
                '/signin - Sign in\n' +
                '/signout - Sign out\n' +
                '/stop - Cancel current process'
            );
        }
    } catch (err) {
        console.error('Callback error:', err); // Log error
        await ctx.answerCbQuery('Error processing request'); // Notify via callback on error
    }
});

// Handle stop command to cancel any ongoing process
bot.command('stop', async (ctx) => {
    if (ctx.scene?.current) await ctx.scene.leave(); // Exit any active scene
    delete ctx.session?.signInData; // Clear temporary sign-in data
    await ctx.reply('Operation cancelled.'); // Reply to confirm cancellation
});

// Global error handling for uncaught errors
bot.catch((err, ctx) => {
    console.error('Bot error:', err); // Log error
    ctx.reply('An error occurred. Please try again later.'); // Reply to user on error
});

// Start bot and handle graceful shutdown
bot.launch().catch(err => { // Start bot and catch launch errors
    console.error('Bot launch failed:', err); // Log error
    process.exit(1); // Exit process on failure
});

// Handle process termination signals
process.once('SIGINT', () => bot.stop('SIGINT')); // Stop bot on interrupt signal
process.once('SIGTERM', () => bot.stop('SIGTERM')); // Stop bot on termination signal