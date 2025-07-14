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
    { command: 'start', description: 'Start the bot' },
    { command: 'help', description: 'Show help' },
    { command: 'checkloan', description: 'Check loan status' },
    { command: 'balance', description: 'View loan balance' },
    { command: 'loans', description: 'List all loans' },
    { command: 'active_loans', description: 'List active loans (lender only)' },
    { command: 'loan_history', description: 'View loan history (lender only)' },
    { command: 'payment_tracking', description: 'Track loan payments (lender only)' },
    { command: 'list_users', description: 'List users by role (admin only)' },
    { command: 'view_logs', description: 'View activity logs (admin only)' },
    { command: 'signin', description: 'Sign in' },
    { command: 'signout', description: 'Sign out' },
    { command: 'stop', description: 'Cancel current process' }
]);

// Helper function to check if user is authenticated and store role
async function checkAuth(ctx) {
    if (!ctx.session?.userId) { // Check if session exists and has userId
        ctx.reply('You are not signed in. Use /signin to link your account.'); // Reply if not signed in
        return false; // Return false to indicate unauthenticated state
    }
    if (!ctx.session.role) { // Ensure role is stored in session
        const [userRows] = await pool.query('SELECT role FROM users WHERE user_id = ?', [ctx.session.userId]); // Query user role
        if (userRows.length === 0) {
            ctx.reply('User account not found. Please contact support.'); // Reply if user not found
            return false;
        }
        ctx.session.role = typeof userRows[0].role === 'string' ? userRows[0].role.toLowerCase() : userRows[0].role; // Store normalized role in session
    }
    return true; // Return true if user is authenticated
}

// Helper function to restrict access to specific roles
function restrictRole(ctx, allowedRoles) {
    if (!ctx.session?.role || !allowedRoles.includes(ctx.session.role)) { // Check if role is valid and allowed
        ctx.reply('You are not authorized to use this command.'); // Reply if unauthorized
        return false;
    }
    return true; // Return true if role is allowed
}

// Helper function to retrieve customer or lender ID from database
async function getCustomerId(userId) {
    const [customerRows] = await pool.query('SELECT customer_id FROM customers WHERE user_id = ?', [userId]); // Query customers table
    return customerRows.length > 0 ? customerRows[0].customer_id : null; // Return customer_id or null
}

async function getLenderId(userId) {
    const [lenderRows] = await pool.query('SELECT lender_id FROM lenders WHERE user_id = ?', [userId]); // Query lenders table
    return lenderRows.length > 0 ? lenderRows[0].lender_id : null; // Return lender_id or null
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
            const [userRows] = await pool.query('SELECT user_id, password, role FROM users WHERE email = ?', [email]); // Query users table for email
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
                hashedPassword,
                role: typeof userRows[0].role === 'string' ? userRows[0].role.toLowerCase() : userRows[0].role // Store normalized role
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
        const { email, userId, hashedPassword, role } = ctx.session?.signInData || {}; // Retrieve sign-in data

        if (!userId || !hashedPassword) { // Check if session data is present
            await ctx.reply('Session expired. Please start over.'); // Reply if session expired
            return ctx.scene.leave(); // Exit scene
        }

        try {
            const safeHash = hashedPassword.replace(/^\$2y\$/, '$2b$'); // Convert PHP bcrypt hash ($2y$) to node-bcrypt ($2b$)
            const isValid = await bcrypt.compare(password, safeHash); // Verify password against hash

            // Send warning to user to delete their password message
            await ctx.reply('⚠️ For your privacy, please delete your password message from the chat history.');

            if (!isValid) { // Check if password is valid
                await ctx.reply('Invalid password. Use /signin to try again.'); // Reply if password is incorrect
                delete ctx.session.signInData; // Clear temporary data
                return ctx.scene.leave(); // Exit scene
            }

        // Determine user type and fetch corresponding ID
        let customerId = null, lenderId = null;
        if (role === 'customer') {
            const [customerRows] = await pool.query('SELECT customer_id, name FROM customers WHERE user_id = ?', [userId]);
            if (customerRows.length === 0) {
                await ctx.reply('Account not found. Contact support.');
                delete ctx.session.signInData;
                return ctx.scene.leave();
            }
            customerId = customerRows[0].customer_id;
            ctx.session.customerName = customerRows[0].name;
        } else if (role === 'lender') {
            const [lenderRows] = await pool.query('SELECT lender_id, name FROM lenders WHERE user_id = ?', [userId]);
            if (lenderRows.length === 0) {
                await ctx.reply('Account not found. Contact support.');
                delete ctx.session.signInData;
                return ctx.scene.leave();
            }
            lenderId = lenderRows[0].lender_id;
            ctx.session.customerName = lenderRows[0].name;
        } else if (role === 'admin') {
            ctx.session.customerName = 'Admin';
        } else {
            await ctx.reply('Invalid user role. Contact support.');
            delete ctx.session.signInData;
            return ctx.scene.leave();
        }

            ctx.session.userId = userId; // Store user ID in session
        ctx.session.role = typeof role === 'string' ? role.toLowerCase() : role; // Store normalized role in session
            ctx.session.customerId = customerId; // Store customer ID (null for non-customers)
            ctx.session.lenderId = lenderId; // Store lender ID (null for non-lenders)
            delete ctx.session.signInData; // Clear temporary sign-in data

            // Escape username for MarkdownV2 - The markdown makes the username bold
            const escapeMarkdownV2 = (text) => text.replace(/([_\*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
            const boldName = `*${escapeMarkdownV2(ctx.session.customerName)}*`;
            // Customize inline keyboard based on role
            const inlineKeyboard = role === 'lender' ? [
                [
                    { text: 'Active Loans', callback_data: 'active_loans' },
                    { text: 'Loan History', callback_data: 'loan_history' }
                ],
                [
                    { text: 'Payment Tracking', callback_data: 'payment_tracking' },
                    { text: 'Help', callback_data: 'help' }
                ]
            ] : role === 'admin' ? [
                [
                    { text: 'List Users', callback_data: 'list_users' },
                    { text: 'View Logs', callback_data: 'view_logs' }
                ],
                [
                    { text: 'Help', callback_data: 'help' }
                ]
            ] : [
                [
                    { text: 'Check Loan', callback_data: 'checkloan' },
                    { text: 'View Balance', callback_data: 'balance' }
                ],
                [
                    { text: 'List Loans', callback_data: 'loans' },
                    { text: 'Help', callback_data: 'help' }
                ]
            ];
            await ctx.reply(`Welcome back, ${boldName}\\!`, {
                parse_mode: 'MarkdownV2',
                reply_markup: { inline_keyboard: inlineKeyboard }
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
    ctx.reply([
        'Available commands:',
        '/start - Start the bot',
        '/help - Show help',
        '/checkloan - Check loan status (customer only)',
        '/balance - View loan balance (customer only)',
        '/loans - List all loans (customer only)',
        '/active_loans - List active loans (lender only)',
        '/loan_history - View loan history (lender only)',
        '/payment_tracking - Track loan payments (lender only)',
        '/list_users - List users by role (admin only)',
        '/view_logs - View activity logs (admin only)',
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

// Handle /checkloan command to prompt for loan ID (customer only)
bot.command('checkloan', async (ctx) => {
    if (!await checkAuth(ctx)) return; // Check if user is signed in, reply if not
    if (!restrictRole(ctx, ['customer'])) return; // Restrict to customer role
    await ctx.reply('Enter loan ID to check:', { reply_markup: { force_reply: true } }); // Prompt for loan ID with forced reply
});

// Handle /balance command to calculate outstanding loan balance (customer only)
bot.command('balance', async (ctx) => {
    if (!await checkAuth(ctx)) return; // Check if user is signed in, reply with "You are not signed in" if not
    if (!restrictRole(ctx, ['customer'])) return; // Restrict to customer role
    
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

// Handle /loans command to list all loans for the user (customer only)
bot.command('loans', async (ctx) => {
    if (!await checkAuth(ctx)) return; // Check if user is signed in, reply with "You are not signed in" if not
    if (!restrictRole(ctx, ['customer'])) return; // Restrict to customer role
    
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

// Handle /activeLoans command to list disbursed loans (lender only)
bot.command('active_loans', async (ctx) => {
    if (!await checkAuth(ctx)) return;
    if (!restrictRole(ctx, ['lender'])) return;
    try {
        const lenderId = await getLenderId(ctx.session.userId);
        if (!lenderId) {
            return ctx.reply('No lender account linked. Please contact support.');
        }
        // Query active (disbursed) loans for this lender, joining loan_offers and aggregating payments
        const [loans] = await pool.query(`
            SELECT 
                loans.loan_id,
                loan_offers.loan_type,
                loans.amount,
                loans.interest_rate,
                loans.duration,
                loans.installments,
                loans.due_date,
                loans.status AS loan_status,
                loans.application_date,
                COALESCE(SUM(payments.amount), 0) AS amount_paid,
                COALESCE(
                    (SELECT p1.installment_balance
                     FROM payments p1
                     WHERE p1.loan_id = loans.loan_id
                       AND (p1.installment_balance IS NOT NULL OR p1.remaining_balance IS NOT NULL)
                     ORDER BY p1.payment_date DESC
                     LIMIT 1),
                    loans.installments
                ) AS latest_installment_balance
            FROM loans
            JOIN loan_offers ON loans.offer_id = loan_offers.offer_id
            LEFT JOIN payments ON loans.loan_id = payments.loan_id
            WHERE loans.lender_id = ?
              AND loans.status = 'disbursed'
            GROUP BY loans.loan_id
            ORDER BY loans.application_date DESC
        `, [lenderId]);
        if (loans.length === 0) {
            return ctx.reply('No active loans found.');
        }
        // Format loan data
        const response = loans.map(loan =>
            `ID: ${loan.loan_id}\nType: ${loan.loan_type}\nAmount: ${loan.amount}\nInterest: ${loan.interest_rate}%\nDuration: ${loan.duration}\nInstallments: ${loan.installments}\nDue: ${loan.due_date || 'N/A'}\nStatus: ${loan.loan_status}\nApplied: ${loan.application_date}\nPaid: ${loan.amount_paid}\nLatest Installment/Remaining Balance: ${loan.latest_installment_balance}`
        ).join('\n\n');
        await ctx.reply(`Active loans:\n\n${response}`);
    } catch (err) {
        console.error('Active loans error:', err);
        await ctx.reply('Error fetching active loans. Try again later.');
    }
});

// Handle /loanHistory command to list all loans (lender only)
bot.command('loan_history', async (ctx) => {
    if (!await checkAuth(ctx)) return; // Check if user is signed in, reply with "You are not signed in" if not
    if (!restrictRole(ctx, ['lender'])) return; // Restrict to lender role
    
    try {
        const lenderId = await getLenderId(ctx.session.userId); // Retrieve lender ID from database
        if (!lenderId) { // Check if lender ID exists
            return ctx.reply('No lender account linked. Please contact support.'); // Reply if no lender found
        }

        // Query all loans for the lender, ordered by application date
        const [loans] = await pool.query(
            'SELECT loan_id, amount, status, due_date FROM loans WHERE lender_id = ? ORDER BY application_date DESC',
            [lenderId]
        );

        if (loans.length === 0) { // Check if any loans exist
            return ctx.reply('No loans found.'); // Reply if no loans found
        }

        // Format loan data into a readable string
        const response = loans.map(loan => 
            `ID: ${loan.loan_id}\nAmount: ${loan.amount}\nStatus: ${loan.status}\nDue: ${loan.due_date || 'N/A'}`
        ).join('\n\n');

        await ctx.reply(`Loan history:\n\n${response}`); // Reply with formatted loan list
    } catch (err) {
        console.error('Loan history error:', err); // Log error for debugging
        await ctx.reply('Error fetching loan history. Try again later.'); // Reply on error
    }
});

// Handle /paymentTracking command to prompt for loan ID (lender only)
bot.command('payment_tracking', async (ctx) => {
    if (!await checkAuth(ctx)) return; // Check if user is signed in, reply with "You are not signed in" if not
    if (!restrictRole(ctx, ['lender'])) return; // Restrict to lender role
    await ctx.reply('Enter loan ID to track payments:', { reply_markup: { force_reply: true } }); // Prompt for loan ID with forced reply
});

// Handle /listUsers command to prompt for role filter (admin only)
bot.command('list_users', async (ctx) => {
    if (!await checkAuth(ctx)) return; // Check if user is signed in, reply with "You are not signed in" if not
    if (!restrictRole(ctx, ['admin'])) return; // Restrict to admin role
    await ctx.reply('Please select a role to filter (admin, lender, customer):', { reply_markup: { force_reply: true } }); // Prompt for role filter
});

// Handle /viewLogs command to prompt for time period filter (admin only)
bot.command('view_logs', async (ctx) => {
    if (!await checkAuth(ctx)) return; // Check if user is signed in, reply with "You are not signed in" if not
    if (!restrictRole(ctx, ['admin'])) return; // Restrict to admin role
    await ctx.reply('Please select a time period (today, this week, this month):', { reply_markup: { force_reply: true } }); // Prompt for time period
});

// Handle loan ID, role filter, and time period replies
bot.on('message', async (ctx) => {
    const replyText = ctx.message?.reply_to_message?.text; // Get replied-to message text
    if (!replyText) return; // Ignore if not a reply

    if (!await checkAuth(ctx)) return; // Check if user is signed in, reply with "You are not signed in" if not

    // Handle /checkloan reply (customer only)
    if (replyText.startsWith('Enter loan ID to check')) {
        if (!restrictRole(ctx, ['customer'])) return; // Restrict to customer role
        const loanId = parseInt(ctx.message.text.trim()); // Parse loan ID
        if (isNaN(loanId)) { // Validate loan ID
            return ctx.reply('Invalid loan ID. Please enter a number.', { reply_markup: { remove_keyboard: true } }); // Reply if invalid
        }

        try {
            const customerId = await getCustomerId(ctx.session.userId); // Retrieve customer ID
            if (!customerId) { // Check if customer ID exists
                return ctx.reply('No customer account linked. Please contact support.', { reply_markup: { remove_keyboard: true } }); // Reply if no customer
            }

            // Query loan details for the specified loan ID and customer
            const [loans] = await pool.query(
                'SELECT amount, interest_rate, status, due_date, application_date FROM loans WHERE loan_id = ? AND customer_id = ?',
                [loanId, customerId]
            );

            if (loans.length === 0) { // Check if loan exists
                return ctx.reply('Loan not found or access denied.', { reply_markup: { remove_keyboard: true } }); // Reply if no loan found
            }

            const loan = loans[0]; // Get loan data
            await ctx.reply([ // Reply with formatted loan details
                `Loan ID: ${loanId}`,
                `Amount: ${loan.amount}`,
                `Interest Rate: ${loan.interest_rate}%`,
                `Status: ${loan.status}`,
                `Due Date: ${loan.due_date || 'N/A'}`,
                `Applied: ${loan.application_date}`
            ].join('\n'), { reply_markup: { remove_keyboard: true } });
        } catch (err) {
            console.error('Loan check error:', err); // Log error
            await ctx.reply('Error checking loan. Try again later.', { reply_markup: { remove_keyboard: true } }); // Reply on error
        }
    }
    // Handle /paymentTracking reply (lender only)
    else if (replyText.startsWith('Enter loan ID to track payments')) {
        if (!restrictRole(ctx, ['lender'])) return; // Restrict to lender role
        const loanId = parseInt(ctx.message.text.trim()); // Parse loan ID
        if (isNaN(loanId)) { // Validate loan ID
            return ctx.reply('Invalid loan ID. Please enter a number.', { reply_markup: { remove_keyboard: true } }); // Reply if invalid
        }

        try {
            const lenderId = await getLenderId(ctx.session.userId); // Retrieve lender ID
            if (!lenderId) { // Check if lender ID exists
                return ctx.reply('No lender account linked. Please contact support.', { reply_markup: { remove_keyboard: true } }); // Reply if no lender
            }

            // Verify loan belongs to lender
            const [loanRows] = await pool.query(
                'SELECT loan_id FROM loans WHERE loan_id = ? AND lender_id = ?',
                [loanId, lenderId]
            );
            if (loanRows.length === 0) { // Check if loan exists
                return ctx.reply('Loan not found or access denied.', { reply_markup: { remove_keyboard: true } }); // Reply if no loan
            }

            // Query payment history for the loan
            const [payments] = await pool.query(
                'SELECT payment_id, amount, payment_method, payment_date FROM payments WHERE loan_id = ? ORDER BY payment_date DESC',
                [loanId]
            );

            if (payments.length === 0) { // Check if any payments exist
                return ctx.reply('No payments found for this loan.', { reply_markup: { remove_keyboard: true } }); // Reply if no payments
            }

            // Format payment data
            const response = payments.map(payment =>
                `Payment ID: ${payment.payment_id}\nAmount: ${payment.amount}\nMethod: ${payment.payment_method}\nDate: ${payment.payment_date}`
            ).join('\n\n');

            await ctx.reply(`Payment history for Loan ID ${loanId}:\n\n${response}`, { reply_markup: { remove_keyboard: true } }); // Reply with payment list
        } catch (err) {
            console.error('Payment tracking error:', err); // Log error
            await ctx.reply('Error fetching payment history. Try again later.', { reply_markup: { remove_keyboard: true } }); // Reply on error
        }
    }
    // Handle /listUsers reply (admin only)
    else if (replyText.startsWith('Please select a role to filter')) {
        if (!restrictRole(ctx, ['admin'])) return; // Restrict to admin role
        const role = ctx.message.text.trim().toLowerCase(); // Get role filter
        if (!['admin', 'lender', 'customer'].includes(role)) { // Validate role
            return ctx.reply('Invalid role. Please select admin, lender, or customer.', { reply_markup: { force_reply: true } }); // Reply if invalid
        }

        try {
            // Query users by role
            const [users] = await pool.query(
                'SELECT user_id, user_name, email FROM users WHERE role = ? ORDER BY user_id LIMIT 50',
                [role]
            );

            if (users.length === 0) { // Check if any users exist
                return ctx.reply(`No users found for role ${role}.`, { reply_markup: { remove_keyboard: true } }); // Reply if no users
            }

            // Format user data
            const response = users.map(user =>
                `ID: ${user.user_id}\nName: ${user.user_name}\nEmail: ${user.email}`
            ).join('\n\n');

            await ctx.reply(`Users with role ${role}:\n\n${response}`, { reply_markup: { remove_keyboard: true } }); // Reply with user list
        } catch (err) {
            console.error('List users error:', err); // Log error
            await ctx.reply('Error fetching users. Try again later.', { reply_markup: { remove_keyboard: true } }); // Reply on error
        }
    }
    // Handle /viewLogs reply (admin only)
    else if (replyText.startsWith('Please select a time period')) {
        if (!restrictRole(ctx, ['admin'])) return; // Restrict to admin role
        const period = ctx.message.text.trim().toLowerCase(); // Get time period filter
        if (!['today', 'this week', 'this month'].includes(period)) { // Validate period
            return ctx.reply('Invalid time period. Please select today, this week, or this month.', { reply_markup: { force_reply: true } }); // Reply if invalid
        }

        try {
            let timeFilter;
            if (period === 'today') {
                timeFilter = 'DATE(activity_time) = CURDATE()'; // Filter for today
            } else if (period === 'this week') {
                timeFilter = 'activity_time >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)'; // Filter for last 7 days
            } else {
                timeFilter = 'activity_time >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)'; // Filter for last 30 days
            }

            // Query activity logs with time filter, limited to 10
            const [logs] = await pool.query(
                `SELECT log_id, user_id, activity, activity_time, activity_type 
                 FROM activity 
                 WHERE ${timeFilter} 
                 ORDER BY activity_time DESC 
                 LIMIT 10`
            );

            if (logs.length === 0) { // Check if any logs exist
                return ctx.reply(`No activity logs found for ${period}.`, { reply_markup: { remove_keyboard: true } }); // Reply if no logs
            }

            // Format log data
            const response = logs.map(log =>
                `Log ID: ${log.log_id}\nUser ID: ${log.user_id}\nActivity: ${log.activity}\nType: ${log.activity_type}\nTime: ${log.activity_time}`
            ).join('\n\n');

            await ctx.reply(`Activity logs for ${period}:\n\n${response}`, { reply_markup: { remove_keyboard: true } }); // Reply with log list
        } catch (err) {
            console.error('View logs error:', err); // Log error
            await ctx.reply('Error fetching activity logs. Try again later.', { reply_markup: { remove_keyboard: true } }); // Reply on error
        }
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

        // Determine allowed roles for callback actions
        const actionRoles = {
            checkloan: ['customer'],
            balance: ['customer'],
            loans: ['customer'],
            active_loans: ['lender'],
            loan_history: ['lender'],
            payment_tracking: ['lender'],
            list_users: ['admin'],
            view_logs: ['admin'],
            help: ['customer', 'lender', 'admin']
        };

        if (!actionRoles[data] || !restrictRole(ctx, actionRoles[data])) { // Check if role is allowed for action
            await ctx.answerCbQuery('You are not authorized to use this action'); // Notify via callback
            return;
        }

        let customerId = ctx.session.customerId; // Get customer ID from session
        let lenderId = ctx.session.lenderId; // Get lender ID from session

        if (data === 'checkloan') { // Handle Check Loan button (customer)
            await ctx.answerCbQuery(); // Acknowledge callback
            await ctx.reply('Enter loan ID to check:', { // Prompt for loan ID
                reply_markup: { force_reply: true } 
            });
        }
        else if (data === 'balance') { // Handle View Balance button (customer)
            if (!customerId) { // Check if customer ID exists
                await ctx.answerCbQuery('No customer account linked'); // Notify via callback
                return;
            }
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
        else if (data === 'loans') { // Handle List Loans button (customer)
            if (!customerId) { // Check if customer ID exists
                await ctx.answerCbQuery('No customer account linked'); // Notify via callback
                return;
            }
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
        else if (data === 'active_loans') { // Handle Active Loans button (lender)
            if (!lenderId) { // Check if lender ID exists
                await ctx.answerCbQuery('No lender account linked'); // Notify via callback
                return;
            }
            // Query disbursed loans for the lender
            const [loans] = await pool.query(
                'SELECT loan_id, amount, status FROM loans WHERE lender_id = ? AND status = "disbursed" ORDER BY application_date DESC LIMIT 10',
                [lenderId]
            );

            await ctx.answerCbQuery(); // Acknowledge callback
            if (loans.length === 0) { // Check if any loans exist
                await ctx.reply('No active loans found.'); // Reply if no loans
            } else {
                const response = loans.map(loan => // Format loan data
                    `ID: ${loan.loan_id} | Amount: ${loan.amount} | Status: ${loan.status}`
                ).join('\n');
                await ctx.reply(`Active loans:\n\n${response}`); // Reply with loan list
            }
        }
        else if (data === 'loan_history') { // Handle Loan History button (lender)
            if (!lenderId) { // Check if lender ID exists
                await ctx.answerCbQuery('No lender account linked'); // Notify via callback
                return;
            }
            // Query all loans for the lender
            const [loans] = await pool.query(
                'SELECT loan_id, amount, status FROM loans WHERE lender_id = ? ORDER BY application_date DESC LIMIT 10',
                [lenderId]
            );

            await ctx.answerCbQuery(); // Acknowledge callback
            if (loans.length === 0) { // Check if any loans exist
                await ctx.reply('No loans found.'); // Reply if no loans
            } else {
                const response = loans.map(loan => // Format loan data
                    `ID: ${loan.loan_id} | Amount: ${loan.amount} | Status: ${loan.status}`
                ).join('\n');
                await ctx.reply(`Loan history:\n\n${response}`); // Reply with loan list
            }
        }
        else if (data === 'payment_tracking') { // Handle Payment Tracking button (lender)
            await ctx.answerCbQuery(); // Acknowledge callback
            await ctx.reply('Enter loan ID to track payments:', { reply_markup: { force_reply: true } }); // Prompt for loan ID
        }
        else if (data === 'list_users') { // Handle List Users button (admin)
            await ctx.answerCbQuery(); // Acknowledge callback
            await ctx.reply('Please select a role to filter (admin, lender, customer):', { reply_markup: { force_reply: true } }); // Prompt for role filter
        }
        else if (data === 'view_logs') { // Handle View Logs button (admin)
            await ctx.answerCbQuery(); // Acknowledge callback
            await ctx.reply('Please select a time period (today, this week, this month):', { reply_markup: { force_reply: true } }); // Prompt for time period
        }
        else if (data === 'help') { // Handle Help button (all roles)
            await ctx.answerCbQuery(); // Acknowledge callback
            await ctx.reply(
                'Available commands:\n' +
                '/start - Start the bot\n' +
                '/help - Show help\n' +
                '/checkloan - Check loan status (customer only)\n' +
                '/balance - View loan balance (customer only)\n' +
                '/loans - List all loans (customer only)\n' +
                '/active_loans - List active loans (lender only)\n' +
                '/loan_history - View loan history (lender only)\n' +
                '/payment_tracking - Track loan payments (lender only)\n' +
                '/list_users - List users by role (admin only)\n' +
                '/view_logs - View activity logs (admin only)\n' +
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
    await ctx.reply('Operation cancelled.', {
        reply_markup: { remove_keyboard: true }
    }); // Reply to confirm cancellation and remove force reply UI
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