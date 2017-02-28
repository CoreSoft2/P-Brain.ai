const co = require('co')

const sqlite3 = require('sqlite3').verbose()
let db = null

const setupQuery =
    'CREATE TABLE IF NOT EXISTS users(user_id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY NOT NULL, timestamp INT DEFAULT (strftime(\'%s\',\'now\')), user_id INTEGER REFERENCES users(user_id));' +
    'CREATE TABLE IF NOT EXISTS queries(query_id INTEGER PRIMARY KEY, query TEXT NOT NULL, timestamp INT DEFAULT (strftime(\'%s\',\'now\')), user_id INTEGER REFERENCES users(user_id));' +
    'CREATE TABLE IF NOT EXISTS responses(query_id INTEGER PRIMARY KEY REFERENCES queries(query_id), response TEXT NOT NULL, skill TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS global_settings(key TEXT PRIMARY KEY, value TEXT);' +
    'CREATE TABLE IF NOT EXISTS skill_settings(skill TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(skill, key));' +
    'CREATE TABLE IF NOT EXISTS user_settings(user_id INTEGER REFERENCES users(user_id), skill TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(user_id, skill, key));' +
    'CREATE TABLE IF NOT EXISTS version(version INTEGER);'

function * queryWrapper(fn, query, values) {
    if (values) {
        fn = fn.bind(db, query, values)
    } else {
        fn = fn.bind(db, query)
    }
    return new Promise((resolve, reject) => {
        try {
            fn((err, rows) => {
                if (err) {
                    reject(new Error(`Error running query: ${query} - ${JSON.stringify(values)}: ${err}`))
                } else {
                    resolve(rows);
                }
            })
        } catch(err) {
            reject(err)
        }
    })
}

function makeConditionalQuery(query, conditions, values) {
    const endConditions = []
    const endValues = []
    for (let i = 0; i < conditions.length; i++) {
        if (values[i] != undefined && values[i] != null) {
            endConditions.push(conditions[i])
            endValues.push(values[i])
        }
    }
    for (let i = 0; i < endConditions.length; i++) {
        if (i == 0) {
            query = `${query} WHERE ${endConditions[i]}`
        } else {
            query = `${query} AND ${endConditions[i]}`
        }
    }
    return {query: query, values: endValues}
}

function * allQueryWrapper(query, values, key) {
    const rows = yield queryWrapper(db.all, query, values)
    if (Array.isArray(rows) && rows.length > 0) {
        rows.map((row) => {
            row.value = JSON.parse(row.value)
        })
        if (key) {
            return rows[0].value
        } else {
            return rows
        }
    }
    return undefined
}

function * getVersion() {
    const row = yield queryWrapper(db.get, 'SELECT * FROM version ORDER BY version DESC LIMIT 1')
    return row.version
}

function * setVersion(version) {
    yield queryWrapper(db.get, 'INSERT OR REPLACE INTO version(version) VALUES (?)', [version])
}

function * databaseV1Setup() {
    yield queryWrapper(db.run, 'ALTER TABLE users ADD is_admin INTEGER DEFAULT 0')
}

function * databaseV2Setup() {
    const query = 'ALTER TABLE tokens ADD name TEXT DEFAULT NULL;' +
            'ALTER TABLE queries ADD token TEXT REFERENCES tokens(token);'
    yield queryWrapper(db.exec, query)
}

function * createDb(database) {
    return new Promise((resolve, reject) => {
        try {
            const local_db = new sqlite3.cached.Database(database, err => {
                if (err) {
                    reject(err)
                } else {
                    resolve(local_db)
                }
            })
        } catch(err) {
            reject(err)
        }
    })
}

function * setup(database) {
    db = yield createDb(database)
    yield queryWrapper(db.exec, setupQuery)
    const version = yield getVersion()
    switch(version) {
        case 0:
            yield databaseV1Setup()
            yield setVersion(1)
            // Fallthrough.
        case 1:
            yield databaseV2Setup()
            yield setVersion(2)
            // Fallthrough.
        default: break
    }
}

function * getUserFromName(username) {
    const user = yield queryWrapper(db.get, 'SELECT user_id, username, is_admin FROM users WHERE username = ?', [username])
    if (user) {
        user.is_admin = user.is_admin == 1
    }
    return user
}

function * saveUser(user) {
    const dbuser = yield getUserFromName(user.username)
    const is_admin = (user.is_admin) ? user.is_admin : 0
    if (dbuser) {
        yield queryWrapper(db.run, 'UPDATE users SET username=?,password=?,is_admin=? WHERE user_id=?', [user.username, user.password, is_admin, dbuser.user_id])
    } else {
        yield queryWrapper(db.run, 'INSERT INTO users(username, password, is_admin) VALUES(?, ?, ?)', [user.username, user.password, is_admin])
    }
}

function * getUser(username, password) {
    const user = yield queryWrapper(db.get, 'SELECT user_id, username, is_admin FROM users WHERE username = ? AND password = ?', [username, password])
    if (user) {
        user.is_admin = user.is_admin == 1
    }
    return user
}

function * setValue(skill, user, key, value) {
    value = JSON.stringify(value)
    yield queryWrapper(db.run, 'INSERT OR REPLACE INTO user_settings(skill, user_id, key, value) VALUES (?, ?, ?, ?)', [skill, user.user_id, key, value])
}

function * deleteValue(skill, user, key) {
    yield queryWrapper(db.run, 'DELETE FROM user_settings WHERE skill = ? AND user_id = ? AND key = ?', [skill, user.user_id, key])
}

function * getValue(skill, user, key) {
    const base = 'SELECT skill, users.username, key, value FROM user_settings INNER JOIN users ON users.user_id = user_settings.user_id'
    let user_id = (user) ? user.user_id : undefined
    const query = makeConditionalQuery(base, ['skill = ?', 'user_settings.user_id = ?', 'key = ?'], [skill, user_id, key])
    query.query += ' ORDER BY skill ASC, users.username ASC, key ASC'
    return yield allQueryWrapper(query.query, query.values, key)
}

function * setSkillValue(skill, key, value) {
    value = JSON.stringify(value)
    yield queryWrapper(db.run, 'INSERT OR REPLACE INTO skill_settings(skill, key, value) VALUES (?, ?, ?)', [skill, key, value])
}

function * getSkillValue(skill, key) {
    const base = 'SELECT skill, key, value FROM skill_settings'
    const query = makeConditionalQuery(base, ['skill = ?', 'key = ?'], [skill, key])
    query.query += ' ORDER BY skill ASC, key ASC'
    return yield allQueryWrapper(query.query, query.values, key)
}

function * deleteSkillValue(skill, key) {
    yield queryWrapper(db.run, 'DELETE FROM skill_settings WHERE skill = ? AND key = ?', [skill, key])
}

function * setGlobalValue(key, value) {
    value = JSON.stringify(value)
    yield queryWrapper(db.run, 'INSERT OR REPLACE INTO global_settings(key, value) VALUES (?, ?)', [key, value])
}

function * getGlobalValue(key) {
    const base = 'SELECT key, value FROM global_settings'
    const query = makeConditionalQuery(base, ['key = ?'], [key])
    query.query += ' ORDER BY key ASC'
    return yield allQueryWrapper(query.query, query.values, key)
}

function * deleteGlobalValue(key) {
    yield queryWrapper(db.run, 'DELETE FROM global_settings WHERE key = ?', [key])
}

function * saveToken(user, token) {
    const dbtokens = yield getUserTokens(user, token)
    if (dbtokens.length > 0) {
        yield queryWrapper(db.run, 'UPDATE tokens SET name=? WHERE user_id=? AND token=?', [token.name, user.user_id, token.token])
    } else {
        yield queryWrapper(db.run, 'INSERT INTO tokens(token, user_id, name) VALUES(?, ?, ?)', [token.token, user.user_id, token.name])
    }
}

function * deleteToken(token) {
    yield queryWrapper(db.run, 'DELETE FROM tokens WHERE token = ?', [token.token])
}

function * deleteUserTokens(user) {
    yield queryWrapper(db.run, 'DELETE FROM tokens WHERE user_id = ?', [user.user_id])
}

function * getUserFromToken(token) {
    if (token.token) {
        token = token.token
    }
    const user = yield queryWrapper(db.get, 'SELECT users.user_id, users.username, users.is_admin FROM users INNER JOIN tokens ON tokens.user_id=users.user_id WHERE tokens.token = ?', [token])
    if (user) {
        user.is_admin = user.is_admin == 1
    }
    return user
}

function * getUserTokens(user, token) {
    const parsedToken = {
        token: (token ? token.token : undefined),
        name: ((token && token.token == null) ? token.name : undefined)
    }
    const base = 'SELECT token, timestamp, name FROM tokens'
    const query = makeConditionalQuery(base, ['user_id = ?', 'name = ?', 'token = ?'], [user.user_id, parsedToken.name, parsedToken.token])
    return yield queryWrapper(db.all, query.query, query.values)
}

function * addQuery(query, user, token) {
    if (token == null) {
        token = {token: null}
    }
    query = JSON.stringify(query)
    return new Promise((resolve, reject) => {
        try {
            db.run('INSERT INTO queries(query, user_id, token) VALUES(?, ?, ?)', query, user.user_id, token.token, function (err) {
                if (err) {
                    reject(err)
                } else {
                    resolve({query_id: this.lastID, query, user})
                }
            })
        } catch (err) {
            reject(err)
        }
    })
}

function * addResponse(query, skill, response) {
    response = JSON.stringify(response)
    yield queryWrapper(db.run, 'INSERT INTO responses(query_id, skill, response) VALUES(?, ?, ?)', [query.query_id, skill, response])
}

module.exports = {
    setup,
    setValue,
    getValue,
    deleteValue,
    setSkillValue,
    getSkillValue,
    deleteSkillValue,
    setGlobalValue,
    getGlobalValue,
    deleteGlobalValue,
    saveToken,
    deleteToken,
    deleteUserTokens,
    getUserFromToken,
    getUser,
    getUserFromName,
    saveUser,
    getUserTokens,
    addQuery,
    addResponse
}
