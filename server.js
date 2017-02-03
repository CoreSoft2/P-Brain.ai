const express = require('express')
const app = express()
const wrap = require('co-express')
const compression = require('compression')
const fs = require('fs')
const ip = require('ip')
const co = require('co')

const search = require('./api/core-ask.js')
const skills = require('./skills/skills.js')

const address = 'var ip_addr ="' + ip.address() + '";'

app.use(compression({
    threshold: 0,
    level: 9,
    memLevel: 9
}))

app.use((req, res, next) => {
    req.connection.setNoDelay(true)
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Headers', 'X-Requested-With')
    next()
})

app.use(express.static('./src'))

app.get('/api/ip.js', function(req, res) {
    res.send(address);
});

// TODO parse services in query
app.get('/api/ask', wrap(function *(req, res) {
    const input = req.query.q.toLowerCase()

    res.header('Content-Type', 'application/json')

    try {
        const result = yield search.query(input)
        res.send(result)
    } catch (e) {
        console.log(e)
        res.send({ msg: 'Sorry, I didnt understand ' + input, type: 'error' })
    }
}))

const skillsApi = express();
app.use('/api/skills', skillsApi);

co(function * () {
    yield skills.loadSkills(skillsApi);
    yield search.train_recognizer(skills.getSkills());
}).catch(err => {
    console.log(err);
    throw err;
});

app.listen(4567)
console.log('http://localhost:4567')
