// Firefox compatible options script
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// PayPal email for donations
const PAYPAL_EMAIL = 'josegpneto@yahoo.com.br';

// Support button click - Opens PayPal donation page
document.getElementById('supportBtn').addEventListener('click', () => {
  const paypalUrl = `https://www.paypal.com/donate/?business=${encodeURIComponent(PAYPAL_EMAIL)}&currency_code=USD`;
  browserAPI.tabs.create({ url: paypalUrl });
});
