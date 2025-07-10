// firebase.js
const admin = require("firebase-admin");
const serviceAccount = require("./transmart-2185c-firebase-adminsdk-fbsvc-01757b1760.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

module.exports = admin;
