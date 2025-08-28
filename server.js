// // purple-premium-bread-api/server.js
// require('dotenv').config();
// const express = require('express');
// const cors = require('cors');
// const db = require('./db/db');
// const authRoutes = require('./routes/auth');
// const productsRoutes = require('./routes/products');
// const salesRoutes = require('./routes/sales'); 
// const inventoryRoutes = require('./routes/inventory');
// const productionRoutes = require('./routes/production'); // Import the new production route
// const usersRoutes = require('./routes/users'); // Import the new route
// const customersRoutes = require('./routes/customers'); // Import the new route
// const branchesRouter = require('./routes/branches'); // <-- Make sure this line exists
// const servicesRoutes = require('./routes/services'); // <-- Ensure this line is present
// const driversRoutes = require('./routes/drivers');
// const fileUpload = require('express-fileupload'); // ⬅️ Add this line
// const companyRoutes = require('./routes/company'); // Import the company route
// const categoriesRoutes = require('./routes/categories'); // Import the categories route
// const rawMaterialsRoutes = require('./routes/rawMaterials'); // Add this line
// const recipesRoutes = require('./routes/recipes'); // Add this line
// const materialTransactionsRoutes = require('./routes/materialTransactions'); // Add this line
// const paymentsRoutes = require('./routes/payments'); // Add this line
// const alertsRoutes = require('./routes/alerts'); // Add this line

// const app = express();
// const PORT = process.env.PORT || 5000;

// // Middleware
// app.use(cors());
// app.use(express.json());
// app.use(fileUpload()); // ⬅️ Add this line to enable file uploads

// // Routes
// app.use('/api/auth', authRoutes);
// app.use('/api/products', productsRoutes);
// app.use('/api/sales', salesRoutes);
// app.use('/api/inventory', inventoryRoutes);
// app.use('/api/production', productionRoutes); // Use the new production route
// app.use('/api/users', usersRoutes); // Use the new users route
// app.use('/api/customers', customersRoutes); // Use the new customers route
// app.use('/api/branches', branchesRouter); // <-- And this line
// app.use('/api/services', servicesRoutes); // <-- Ensure this line is present
// app.use('/api/drivers', driversRoutes);
// app.use('/api/company', companyRoutes); // Use the company route
// app.use('/api/categories', categoriesRoutes); // Use the categories route
// app.use('/api/raw-materials', rawMaterialsRoutes); // Add this line
// app.use('/api/recipes', recipesRoutes); // Add this line
// app.use('/api/material-transactions', materialTransactionsRoutes); // Add this line
// app.use('/api/payments', paymentsRoutes); // Add this line
// app.use('/api/alerts', alertsRoutes); // Add this line

// // Simple test route
// app.get('/', (req, res) => {
//   res.send('Welcome to the Purple Premium Bread API!');
// });

// // Start the server
// app.listen(PORT, () => {
//   console.log(`Server is running on port ${PORT}`);
// });


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


const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
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
            console.log('Automated alert generation scheduled.');
        });
    } catch (err) {
        console.error('Failed to start server:', err); // Error message adjusted as DB connection is implicitly handled
        process.exit(1);
    }
};

startServer();
