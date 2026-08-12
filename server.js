// purple-premium-bread-api/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db/db');
const authRoutes = require('./routes/auth');
const productsRoutes = require('./routes/products');
const salesRoutes = require('./routes/sales');
const inventoryRoutes = require('./routes/inventory');
const productionRoutes = require('./routes/production');
const usersRoutes = require('./routes/users');
const customersRoutes = require('./routes/customers');
const branchesRouter = require('./routes/branches');
const servicesRoutes = require('./routes/services');
const driversRoutes = require('./routes/drivers');
const fileUpload = require('express-fileupload');
const companyRoutes = require('./routes/company');
const categoriesRoutes = require('./routes/categories');
const rawMaterialsRoutes = require('./routes/rawMaterials');
const recipesRoutes = require('./routes/recipes');
const materialTransactionsRoutes = require('./routes/materialTransactions');
const paymentsRoutes = require('./routes/payments');
const { router: alertsRouter, checkAndGenerateAlerts } = require('./routes/alerts');
const staffRoutes = require('./routes/staff');
const dashboardRoutes = require('./routes/dashboard');
const reportsRoutes = require('./routes/reports');
const analysisRoutes = require('./routes/analysis');
const wasteStock = require('./routes/wasteStock');
const exchangeRoutes = require('./routes/exchange');
const managerRoutes = require('./routes/manager');
const stockIssueLogRoutes = require('./routes/stock-issue-log');
const operatingExpensesRoutes = require('./routes/operatingExpenses');
const salariesRoutes = require('./routes/salaries');
const staffMembersRoutes = require('./routes/staffs');
const companyDebtsRoutes = require('./routes/companyDebts');
const riderRoutes = require('./routes/riders');

// System upgrades: permissions, workflow, audit, money management
const resolveUser = require('./middleware/resolveUser');
const { permissionGuard } = require('./middleware/permissionGuard');
const { workflowGate } = require('./utils/workflow');
const { auditMiddleware } = require('./utils/audit');
const permissionsRoutes = require('./routes/permissions');
const approvalsRoutes = require('./routes/approvals');
const moneyRoutes = require('./routes/money');
const returnsRoutes = require('./routes/returns');
const walletsRoutes = require('./routes/wallets');
const aiAssistantRoutes = require('./routes/aiAssistant');
const chatRoutes = require('./routes/chat');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
    origin: ['https://purple-premium-bread.vercel.app', 'http://localhost:5173'],
    credentials: true
}));

app.use(express.json());
app.use(fileUpload());

// --- Security & governance layer (order matters) ---
// 1. Resolve the JWT (non-blocking: attaches req.user when a valid token is present)
// 2. Audit every mutating action (web now, WhatsApp later)
// 3. Enforce role permissions from the permissions catalog
// 4. Stage configured actions for approval instead of executing them immediately
app.use('/api', resolveUser);
app.use('/api', auditMiddleware);
app.use('/api', permissionGuard);
app.use('/api', workflowGate);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/production', productionRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/branches', branchesRouter);
app.use('/api/services', servicesRoutes);
app.use('/api/drivers', driversRoutes);
app.use('/api/company', companyRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/raw-materials', rawMaterialsRoutes);
app.use('/api/recipes', recipesRoutes);
app.use('/api/material-transactions', materialTransactionsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/alerts', alertsRouter);
app.use('/api/staff', staffRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/analysis', analysisRoutes);
app.use('/api/waste-stock', wasteStock);
app.use('/api/exchange', exchangeRoutes);
app.use('/api/manager', managerRoutes);
app.use('/api/stock-issue-log', stockIssueLogRoutes);
app.use('/api/operating-expenses', operatingExpensesRoutes);
app.use('/api/salaries', salariesRoutes);
app.use('/api/staffs', staffMembersRoutes);
app.use('/api/salaries/company-debts', companyDebtsRoutes);
app.use('/api/riders', riderRoutes);
app.use('/api/permissions', permissionsRoutes);
app.use('/api/approvals', approvalsRoutes);
app.use('/api/money', moneyRoutes);
app.use('/api/returns', returnsRoutes);
app.use('/api/wallets', walletsRoutes);
app.use('/api/ai', aiAssistantRoutes);
app.use('/api/chat', chatRoutes);

// Simple test route
app.get('/', (req, res) => {
    res.send('Welcome to the Purple Premium Bread API!');
});

// Start the server
const startServer = async () => {
    try {
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);

            // Schedule Automated Alert Generation (every 3 minutes)
            checkAndGenerateAlerts();
            setInterval(checkAndGenerateAlerts, 3 * 60 * 1000);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
};

startServer();
