
// purple-premium-bread-api/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db/db'); // No change here, still import the db module
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
const staffRoutes = require('./routes/staff'); // ✨ Add this line
const dashboardRoutes = require('./routes/dashboard'); // ✨ Add this line
const reportsRoutes = require('./routes/reports'); // ✨ Add this line
const analysisRoutes = require('./routes/analysis'); // ✨ Add this line
const wasteStock = require('./routes/wasteStock');
const exchangeRoutes = require('./routes/exchange'); // ✨ Add this line
const managerRoutes = require('./routes/manager'); // ✨ Add this line


const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
// app.use(cors());
app.use(cors({
  origin: ['https://purple-premium-bread.vercel.app', "http://localhost:5173"],
  credentials: true // Optional: only if using cookies/sessions
}));

app.use(express.json());
app.use(fileUpload());

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
app.use('/api/staff', staffRoutes); // ✨ Add this line
app.use('/api/dashboard', dashboardRoutes); // ✨ Add this line
app.use('/api/reports', reportsRoutes); // ✨ Add this line
app.use('/api/analysis', analysisRoutes); // ✨ Add this line
app.use('/api/waste-stock', wasteStock);
app.use('/api/exchange', exchangeRoutes); // ✨ Add this line
app.use('/api/manager', managerRoutes); // ✨ Add this line

// Simple test route
app.get('/', (req, res) => {
    res.send('Welcome to the Purple Premium Bread API!');
});

// Start the server
const startServer = async () => {
    try {
        // REMOVED: await db.connect();
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);

            // Schedule Automated Alert Generation
            checkAndGenerateAlerts();
            setInterval(checkAndGenerateAlerts, 3 * 60 * 1000); // Every 5 minutes
            // console.log('Automated alert generation scheduled.');
        });
    } catch (err) {
        console.error('Failed to start server:', err); // Error message adjusted as DB connection is implicitly handled
        process.exit(1);
    }
};

startServer();
