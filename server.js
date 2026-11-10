const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// Environment detection
const isProduction = process.env.NODE_ENV === 'production';
const MPESA_BASE_URL = isProduction 
  ? 'https://api.safaricom.co.ke' 
  : 'https://sandbox.safaricom.co.ke';

// Initialize Supabase (Make sure to add these to Render Environment Variables!)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

console.log(`⚙️  Running in ${isProduction ? 'PRODUCTION' : 'SANDBOX'} mode`);

const transactions = {};

app.get('/', (req, res) => {
  res.json({ status: 'Backend is running!', mode: isProduction ? 'production' : 'sandbox' });
});

async function getAccessToken() {
  const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get(`${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  return res.data.access_token;
}

app.post('/api/mpesa/stkpush', async (req, res) => {
  try {
    const { phone, amount } = req.body;
    if (!phone || !amount) return res.status(400).json({ success: false, error: 'Phone and amount required' });

    const token = await getAccessToken();
    
    let formattedPhone = phone.replace(/\D/g, '');
    if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.slice(1);
    else if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) formattedPhone = '254' + formattedPhone;

    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
    const password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');

    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE, // HO Number (4566747)
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: Math.round(amount),
      PartyA: formattedPhone,
      PartyB: '8189020', // Store/Till Number
      PhoneNumber: formattedPhone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: 'DataStore',
      TransactionDesc: 'Data Bundle Purchase'
    };

    const response = await axios.post(
      `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Save the pending transaction with the phone number and amount
    transactions[response.data.CheckoutRequestID] = { 
      status: 'pending', 
      phone: formattedPhone, 
      amount: Math.round(amount) 
    };
    
    res.json({ success: true, checkoutId: response.data.CheckoutRequestID });
    
  } catch (error) {
    console.error('❌ SAFARICOM ERROR:', JSON.stringify(error.response?.data || error.message, null, 2));
    res.status(500).json({ success: false, error: error.response?.data?.errorMessage || error.message });
  }
});

app.post('/api/mpesa/callback', async (req, res) => {
  const callbackData = req.body.Body?.stkCallback;
  if (!callbackData) return res.status(400).send('Invalid');
  
  const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = callbackData;

  if (ResultCode === 0) {
    // Extract details
    const receipt = CallbackMetadata?.Item?.find(item => item.Name === 'MpesaReceiptNumber')?.Value || 'N/A';
    const amountPaid = CallbackMetadata?.Item?.find(item => item.Name === 'Amount')?.Value || 0;
    const phoneNumber = CallbackMetadata?.Item?.find(item => item.Name === 'PhoneNumber')?.Value || '';

    // Update local memory
    transactions[CheckoutRequestID] = { status: 'success', receipt };

    // SAVE TO SUPABASE
    console.log(`💾 Saving order to Supabase...`);
    const { data, error } = await supabase
      .from('orders')
      .insert({
        bundle_name: 'Bundle Purchase', // You can send this from frontend if needed
        network: 'safaricom',
        recipient_phone: phoneNumber.toString(),
        mpesa_phone: phoneNumber.toString(),
        receipt: receipt,
        price: amountPaid
      });

    if (error) {
      console.error('❌ SUPABASE ERROR:', error);
    } else {
      console.log(`✅ Order saved to Supabase: ${receipt}`);
    }

    console.log(`✅ Success Callback Received: ${receipt}`);
  } else {
    transactions[CheckoutRequestID] = { status: 'failed', reason: ResultDesc };
    console.log(`❌ Failed: ${ResultDesc}`);
  }
  
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.get('/api/mpesa/status/:checkoutId', (req, res) => {
  res.json(transactions[req.params.checkoutId] || { status: 'unknown' });
});

app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));
