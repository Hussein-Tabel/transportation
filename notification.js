const admin = require("./firebase");

/**
 * Send FCM notification to multiple device tokens using latest Firebase SDK.
 */
async function sendNotificationToPassengers(tokens, title, message) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    console.log("No tokens to send notifications to.");
    return;
  }

  const messagePayload = {
    notification: {
      title: title,
      body: message,
    },
    tokens: tokens,
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(messagePayload);
    console.log(`Notifications sent: ${response.successCount}`);
    if (response.failureCount > 0) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          console.error(`Failed for token ${tokens[idx]}:`, resp.error.message);
        }
      });
    }
  } catch (error) {
    console.error("Error sending notification:", error.message);
  }
}

module.exports = { sendNotificationToPassengers };
