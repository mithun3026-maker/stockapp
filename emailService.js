const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log('⚠️ Email not configured. Set SMTP_USER and SMTP_PASS in .env');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  return transporter;
}

// ========== SEND STORE REMINDER ==========
async function sendStoreReminder(store, weekStart) {
  const t = getTransporter();
  if (!t || !store.manager_email) return;

  const url = process.env.APP_URL || 'http://localhost:3000';

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;">
    <div style="background:#dc3545;color:#fff;padding:25px;text-align:center;border-radius:10px 10px 0 0;">
      <h2>⚠️ Stock Count Pending!</h2>
    </div>
    <div style="padding:25px;background:#f8f9fa;">
      <p>Dear <b>${store.manager_name}</b>,</p>
      <p>Weekly stock count for <b>${store.store_name}</b> (week of <b>${weekStart}</b>)
         is <span style="color:red;font-weight:bold;">NOT submitted</span>.</p>
      <p>⏰ Deadline: <b>Monday, End of Day</b></p>
      <div style="text-align:center;margin:25px 0;">
        <a href="${url}" style="background:#007bff;color:#fff;padding:14px 35px;text-decoration:none;
           border-radius:8px;font-size:16px;font-weight:bold;">📝 Submit Now</a>
      </div>
    </div>
  </div>`;

  try {
    await t.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to: store.manager_email,
      subject: `⚠️ Stock Count Pending - ${store.store_name}`,
      html
    });
    console.log(`📧 Reminder → ${store.manager_email}`);
  } catch (e) {
    console.error(`❌ Email failed (${store.manager_email}):`, e.message);
  }
}

// ========== ADMIN STATUS SUMMARY ==========
async function sendAdminStatusSummary(statusData, weekStart) {
  const t = getTransporter();
  if (!t || !process.env.ADMIN_EMAILS) return;

  const submitted = statusData.filter(s => s.submitted);
  const missing = statusData.filter(s => !s.submitted);

  let rows = '';
  missing.forEach(s => {
    rows += `<tr style="background:#f8d7da;">
      <td style="padding:10px;border:1px solid #ddd;">${s.store_name}</td>
      <td style="padding:10px;border:1px solid #ddd;">${s.manager_name||'-'}</td>
      <td style="padding:10px;border:1px solid #ddd;">❌ Missing</td></tr>`;
  });
  submitted.forEach(s => {
    rows += `<tr style="background:#d4edda;">
      <td style="padding:10px;border:1px solid #ddd;">${s.store_name}</td>
      <td style="padding:10px;border:1px solid #ddd;">${s.manager_name||'-'}</td>
      <td style="padding:10px;border:1px solid #ddd;">✅ Submitted (${s.submitted_by||''})</td></tr>`;
  });

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:700px;margin:auto;">
    <div style="background:#343a40;color:#fff;padding:25px;text-align:center;border-radius:10px 10px 0 0;">
      <h2>📋 Stock Count Status</h2>
      <p style="opacity:.8;">Week of ${weekStart}</p>
    </div>
    <div style="padding:25px;background:#f8f9fa;">
      <h3>${submitted.length}/${statusData.length} Stores Submitted</h3>
      <table style="width:100%;border-collapse:collapse;background:#fff;">
        <tr style="background:#343a40;color:#fff;">
          <th style="padding:12px;border:1px solid #ddd;">Store</th>
          <th style="padding:12px;border:1px solid #ddd;">Manager</th>
          <th style="padding:12px;border:1px solid #ddd;">Status</th>
        </tr>
        ${rows}
      </table>
    </div>
  </div>`;

  try {
    await t.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to: process.env.ADMIN_EMAILS,
      subject: `📋 Stock Status: ${submitted.length}/${statusData.length} — Week ${weekStart}`,
      html
    });
    console.log('📧 Admin summary sent');
  } catch (e) {
    console.error('❌ Admin email failed:', e.message);
  }
}

// ========== PILFERAGE REPORT EMAIL ==========
async function sendPilferageReport(reportData) {
  const t = getTransporter();
  const to = process.env.REPORT_EMAILS || process.env.ADMIN_EMAILS;
  if (!t || !to) return;

  const { summary, data, week_start } = reportData;

  let rows = '';
  data.forEach(r => {
    const bg = r.flag==='LOSS' ? '#f8d7da' : r.flag==='EXCESS' ? '#fff3cd' : '#d4edda';
    const icon = r.flag==='LOSS' ? '🔴' : r.flag==='EXCESS' ? '🟡' : '🟢';
    rows += `<tr style="background:${bg};">
      <td style="padding:6px 8px;border:1px solid #ddd;">${r.store_name}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${r.product_name}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:center;">${r.opening}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:center;">${r.received}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:center;">${r.sold}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:center;">${r.expected_closing}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:center;">${r.physical_count}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:center;font-weight:bold;">${r.variance}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:center;">${r.variance_pct}%</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:center;">${icon} ${r.flag}</td>
    </tr>`;
  });

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:950px;margin:auto;">
    <div style="background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:25px;text-align:center;border-radius:10px 10px 0 0;">
      <h2>📊 Weekly Pilferage & Loss Report</h2>
      <p>Week of ${week_start}</p>
    </div>
    <div style="padding:25px;background:#f8f9fa;">
      <table style="width:100%;margin-bottom:20px;"><tr>
        <td style="background:#fff;padding:15px;text-align:center;border-radius:8px;width:25%;">
          <div style="font-size:26px;font-weight:bold;color:#007bff;">${summary.total_items}</div>
          <div style="color:#666;font-size:12px;">Items Tracked</div></td>
        <td style="background:#fff;padding:15px;text-align:center;border-radius:8px;width:25%;">
          <div style="font-size:26px;font-weight:bold;color:#dc3545;">${summary.loss_items}</div>
          <div style="color:#666;font-size:12px;">🔴 Loss Items</div></td>
        <td style="background:#fff;padding:15px;text-align:center;border-radius:8px;width:25%;">
          <div style="font-size:26px;font-weight:bold;color:#dc3545;">${summary.total_loss_qty}</div>
          <div style="color:#666;font-size:12px;">Total Loss Qty</div></td>
        <td style="background:#fff;padding:15px;text-align:center;border-radius:8px;width:25%;">
          <div style="font-size:26px;font-weight:bold;color:#ffc107;">${summary.excess_items}</div>
          <div style="color:#666;font-size:12px;">🟡 Excess</div></td>
      </tr></table>
      <table style="width:100%;border-collapse:collapse;background:#fff;font-size:12px;">
        <tr style="background:#343a40;color:#fff;">
          <th style="padding:10px;border:1px solid #ddd;">Store</th>
          <th style="padding:10px;border:1px solid #ddd;">Product</th>
          <th style="padding:10px;border:1px solid #ddd;">Opening</th>
          <th style="padding:10px;border:1px solid #ddd;">Received</th>
          <th style="padding:10px;border:1px solid #ddd;">Sold</th>
          <th style="padding:10px;border:1px solid #ddd;">Expected</th>
          <th style="padding:10px;border:1px solid #ddd;">Physical</th>
          <th style="padding:10px;border:1px solid #ddd;">Variance</th>
          <th style="padding:10px;border:1px solid #ddd;">Var%</th>
          <th style="padding:10px;border:1px solid #ddd;">Flag</th>
        </tr>
        ${rows}
      </table>
    </div>
    <div style="background:#343a40;color:#aaa;padding:12px;text-align:center;border-radius:0 0 10px 10px;font-size:11px;">
      Auto-generated | ${new Date().toLocaleString()}</div>
  </div>`;

  try {
    await t.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to,
      subject: `📊 Pilferage Report — Week ${week_start} | ${summary.loss_items} Losses, ${summary.total_loss_qty} Units`,
      html
    });
    console.log('📧 Pilferage report emailed');
  } catch (e) {
    console.error('❌ Report email failed:', e.message);
  }
}

module.exports = { sendStoreReminder, sendAdminStatusSummary, sendPilferageReport };