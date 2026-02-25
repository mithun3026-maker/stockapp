require('dotenv').config();
var express = require('express');
var path = require('path');
var cron = require('node-cron');
var db = require('./database');
var email = require('./emailService');
var app = express();
var PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

db.seedSampleData();

app.get('/', function(req, res) {
  res.render('form', { stores: db.storeOps.getAll.all(), products: db.productOps.getAll.all(), weekStart: db.getWeekStart() });
});

app.get('/status', function(req, res) {
  var w = db.getWeekStart();
  res.render('status', { status: db.getSubmissionStatus(w), weekStart: w });
});

app.get('/report', function(req, res) {
  var w = req.query.week || db.getWeekStart();
  res.render('report', { report: db.getPilferageReport(w), weekStart: w, weeks: db.getAvailableWeeks() });
});

app.get('/admin', function(req, res) {
  res.render('admin', { stores: db.storeOps.getAll.all(), products: db.productOps.getAll.all() });
});

app.get('/api/last-week-closing/:storeId', function(req, res) {
  var prev = db.getPreviousWeekStart();
  var data = db.submissionOps.getLastWeekClosing.all(prev, req.params.storeId);
  var result = {};
  for (var i = 0; i < data.length; i++) {
    result[data[i].product_id] = { physical_count: data[i].physical_count };
  }
  res.json(result);
});

app.post('/api/submit', function(req, res) {
  try {
    var b = req.body;
    if (!b.store_id || !b.submitted_by || !b.items) return res.status(400).json({ success: false, message: 'Missing fields' });
    var count = db.bulkSubmit(b.items, db.getWeekStart(), b.store_id, b.store_name, b.submitted_by);
    res.json({ success: true, message: 'Submitted for ' + b.store_name + ' (' + count + ' items)' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/stores', function(req, res) {
  try { db.storeOps.insert.run(req.body); res.json({ success: true }); }
  catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/products', function(req, res) {
  try { db.productOps.insert.run(req.body); res.json({ success: true }); }
  catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

app.delete('/api/stores/:id', function(req, res) {
  db.storeOps.deactivate.run(req.params.id); res.json({ success: true });
});

app.delete('/api/products/:id', function(req, res) {
  db.productOps.deactivate.run(req.params.id); res.json({ success: true });
});

function checkAndNotify() {
  console.log('Checking missing submissions...');
  var weekStart = db.getWeekStart();
  var status = db.getSubmissionStatus(weekStart);
  var missing = [];
  for (var i = 0; i < status.length; i++) {
    if (!status[i].submitted) missing.push(status[i]);
  }
  if (missing.length === 0) {
    console.log('All stores submitted!');
    return;
  }
  console.log(missing.length + ' stores pending');
  var appUrl = process.env.APP_URL || ('http://localhost:' + PORT);
  for (var j = 0; j < missing.length; j++) {
    email.sendStoreReminder(missing[j], weekStart, appUrl, null);
  }
  email.sendAdminSummary(status, weekStart, null);
}

app.post('/api/trigger-reminders', function(req, res) {
  checkAndNotify();
  res.json({ success: true, message: 'Reminders sent' });
});

app.post('/api/trigger-report', function(req, res) {
  var report = db.getPilferageReport();
  email.sendPilferageReport(report, null);
  res.json({ success: true, message: 'Report emailed' });
});

cron.schedule('0 18 * * 1', function() {
  console.log('Monday 6PM reminder');
  checkAndNotify();
});

cron.schedule('0 22 * * 1', function() {
  console.log('Monday 10PM reminder');
  checkAndNotify();
});

cron.schedule('0 8 * * 2', function() {
  console.log('Tuesday 8AM report');
  var report = db.getPilferageReport();
  if (report.data.length > 0) {
    email.sendPilferageReport(report, null);
  }
});

app.listen(PORT, function() {
  console.log('App running on port ' + PORT);
});
