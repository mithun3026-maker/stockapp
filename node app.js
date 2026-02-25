var express = require('express');
var app = express();

app.get('/', function(req, res) {
  res.send('<h1>Hello! App is working!</h1>');
});

app.get('/test', function(req, res) {
  res.send('<h1>Test page works too!</h1>');
});

app.listen(3000, function() {
  console.log('Server running at http://localhost:3000');
});