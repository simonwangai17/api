const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';
const MPESA_BASE_URL = isProduction ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const transactions = {};

app.get('/', (req, res) => res.json({ status: 'Backend running' }));

// ===== BALANCE ENDPOINT =====
app.get('/api/balance/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    
    // Query Supabase for this phone number's orders
    const { data, error } = await supabase
      .from('orders')
      .select('price')
      .eq('recipient_phone', phone);

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({ success: false, error: 'No active package found for this number. Please buy a package first.' });
    }

    // Calculate a mock balance based on their total spend
    const totalSpent = data.reduce((sum, order) => sum + Number(order.price), 0);
    const mockData = (totalSpent / 25).toFixed(1) + ' GB';
    const mockSms = Math.floor(totalSpent / 2) + ' SMS';
    const mockAirtime = 'KES ' + (totalSpent * 0.05).toFixed(2);

    res.json({ success: true, balance: { data: mockData, sms: mockSms, airtime: mockAirtime } });
  } catch (err) {
    console.error('Balance Error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch balance.' });
  }
});

async function getAccessToken() {
  const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get(`${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
  return res.data.access_token;
}

app.post('/api/mpesa/stkpush', async (req, res) => {
  try {
    const { phone, amount, bundleName, network } = req.body;
    const token = await getAccessToken();
    
    let formattedPhone = phone.replace(/\D/g, '');
    if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.slice(1);

    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
    const password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');

    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: Math.round(amount),
      PartyA: formattedPhone,
      PartyB: '8189020', 
      PhoneNumber: formattedPhone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: 'DataStore',
      TransactionDesc: bundleName ? bundleName.substring(0, 13) : 'Data Bundle'
    };

    const response = await axios.post(`${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`, payload, { headers: { Authorization: `Bearer ${token}` } });

    transactions[response.data.CheckoutRequestID] = { 
      status: 'pending', phone: formattedPhone, amount: Math.round(amount), bundleName, network
    };
    
    res.json({ success: true, checkoutId: response.data.CheckoutRequestID });
  } catch (error) {
    res.status(500).json({ success: false, error: error.response?.data?.errorMessage || error.message });
  }
});

app.post('/api/mpesa/callback', async (req, res) => {
  const callbackData = req.body.Body?.stkCallback;
  if (!callbackData) return res.status(400).send('Invalid');
  
  const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = callbackData;

  if (ResultCode === 0) {
    const receipt = CallbackMetadata?.Item?.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
    const amountPaid = CallbackMetadata?.Item?.find(item => item.Name === 'Amount')?.Value;
    const phonePaid = CallbackMetadata?.Item?.find(item => item.Name === 'PhoneNumber')?.Value;
    const txDetails = transactions[CheckoutRequestID] || {};

    transactions[CheckoutRequestID] = { status: 'success', receipt };

    console.log(`💾 Saving order to Supabase...`);
    const { error } = await supabase.from('orders').insert({
      bundle_name: txDetails.bundleName || 'Unknown',
      network: txDetails.network || 'safaricom',
      recipient_phone: txDetails.phone || phonePaid.toString(),
      mpesa_phone: phonePaid.toString(),
      receipt: receipt,
      price: amountPaid
    });

    if (error) console.error('❌ SUPABASE ERROR:', error);
    else console.log(`✅ Order saved: ${receipt}`);
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
