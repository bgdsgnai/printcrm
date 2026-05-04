const express = require('express');
const { Pool } = require('pg'); // ИСПОЛЬЗУЕМ POSTGRESQL
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const port = process.env.PORT || 3000; // Render сам назначит порт
const SECRET_KEY = 'complex_print_secure_key_2026';

// НАСТРОЙКА TELEGRAM БОТА
const botToken = '8713497698:AAGiWw4mnEHvEdMyY2Xj4ihKhEDBEgsHiP8';
const bot = new TelegramBot(botToken, {polling: true});
let botUsername = '';
bot.getMe().then(info => botUsername = info.username).catch(err => console.log('TG Ошибка:', err.message));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ПОДКЛЮЧЕНИЕ К ВАШЕЙ ОБЛАЧНОЙ БАЗЕ NEON
const pool = new Pool({
    connectionString: 'postgresql://neondb_owner:npg_od2aWvE3Ryju@ep-small-union-alpz9rbh-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require',
    ssl: { rejectUnauthorized: false }
});

pool.connect((err) => {
    if (err) console.error('Ошибка подключения к Neon БД:', err.stack);
    else console.log('✅ ОБЛАЧНАЯ БАЗА NEON УСПЕШНО ПОДКЛЮЧЕНА!');
});

// СОЗДАЕМ ТАБЛИЦЫ В ОБЛАКЕ (ЕСЛИ ИХ НЕТ)
const initDB = async () => {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY, 
            name VARCHAR(255) UNIQUE NOT NULL, 
            role VARCHAR(255) NOT NULL, 
            password VARCHAR(255) NOT NULL,
            telegram_chat_id VARCHAR(255),
            avatar TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS orders (
            id SERIAL PRIMARY KEY, 
            order_number VARCHAR(255), 
            product_type VARCHAR(255) NOT NULL, 
            client_name VARCHAR(255) NOT NULL, 
            created_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP, 
            deadline VARCHAR(255), 
            details TEXT, 
            amount INTEGER, 
            price REAL, 
            status VARCHAR(50) DEFAULT 'Новый', 
            creator_name VARCHAR(255), 
            assignee VARCHAR(255)
        )`);
        console.log('✅ Таблицы синхронизированы!');

        // Создаем админа по умолчанию, если база пустая
        const adminCheck = await pool.query(`SELECT * FROM users WHERE name = 'Булат'`);
        if (adminCheck.rows.length === 0) {
            const hash = await bcrypt.hash('1234', 10);
            await pool.query(`INSERT INTO users (name, role, password) VALUES ($1, $2, $3)`, ['Булат', 'Супер-Админ', hash]);
            console.log('✅ Аккаунт "Булат" с паролем "1234" создан в облаке!');
        }
    } catch (err) { console.error('Ошибка создания таблиц:', err); }
};
initDB();

// МАГИЯ ПРИВЯЗКИ ТЕЛЕГРАМА
bot.onText(/\/start (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = match[1];
    try {
        await pool.query(`UPDATE users SET telegram_chat_id = $1 WHERE id = $2`, [chatId, userId]);
        bot.sendMessage(chatId, "✅ Отлично! Ваш аккаунт COMPLEX PRINT CRM успешно привязан.\n\nТеперь сюда будут приходить уведомления о заказах, назначенных на вас!");
    } catch(err) {
        bot.sendMessage(chatId, "❌ Ошибка при привязке аккаунта.");
    }
});

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Требуется авторизация.' });
    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ error: 'Недействительный токен.' });
        req.user = user; next();
    });
}

// Генерация ссылки для бота
app.get('/api/telegram-link', authenticateToken, (req, res) => {
    if(!botUsername) return res.status(500).json({error: 'Бот загружается, попробуйте через 5 секунд'});
    res.json({ link: `https://t.me/${botUsername}?start=${req.user.id}` });
});

// Пользователи и авторизация
app.get('/api/users', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, name, role, avatar FROM users ORDER BY id ASC`);
        res.json(result.rows);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/register', async (req, res) => {
    const { name, role, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query(`INSERT INTO users (name, role, password) VALUES ($1, $2, $3)`, [name.trim(), role, hashedPassword]);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: 'Пользователь уже существует' }); }
});

app.post('/api/login', async (req, res) => {
    const { name, password } = req.body;
    try {
        const result = await pool.query(`SELECT * FROM users WHERE name = $1`, [name.trim()]);
        const user = result.rows[0];
        if (!user) return res.status(401).json({ error: 'Неверное имя или пароль' });
        
        const match = await bcrypt.compare(password.trim(), user.password);
        if (!match) return res.status(401).json({ error: 'Неверное имя или пароль' });
        
        const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, SECRET_KEY, { expiresIn: '24h' });
        res.json({ success: true, token, user: { name: user.name, role: user.role, avatar: user.avatar } });
    } catch(err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/users/:id', authenticateToken, async (req, res) => {
    // Проверка прав: только Булат может редактировать других через этот роут
    if (req.user.name !== 'Булат') return res.status(403).json({ error: 'Нет прав' });
    
    const { name, role, password } = req.body;
    try {
        let query;
        let params;

        if (password && password.trim() !== '') {
            // Если пароль введен — хешируем его
            const hashedPassword = await bcrypt.hash(password.trim(), 10);
            query = `UPDATE users SET name = $1, role = $2, password = $3 WHERE id = $4`;
            params = [name.trim(), role, hashedPassword, req.params.id];
        } else {
            // Если поле пароля пустое — обновляем только имя и роль
            query = `UPDATE users SET name = $1, role = $2 WHERE id = $3`;
            params = [name.trim(), role, req.params.id];
        }

        await pool.query(query, params);
        res.json({ success: true });
    } catch(err) { 
        console.error('Ошибка при обновлении пользователя:', err);
        res.status(500).json({ error: 'Ошибка сервера' }); 
    }
});

// АДМИНКА ДЛЯ СОТРУДНИКОВ
app.delete('/api/users/:id', authenticateToken, async (req, res) => {
    if (req.user.name !== 'Булат') return res.status(403).json({ error: 'Нет прав' });
    try {
        await pool.query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/users/:id', authenticateToken, async (req, res) => {
    if (req.user.name !== 'Булат') return res.status(403).json({ error: 'Нет прав' });
    const { name, role, password } = req.body;
    try {
        let query = `UPDATE users SET name = $1, role = $2 WHERE id = $3`;
        let params = [name.trim(), role, req.params.id];
        if (password && password.trim() !== '') {
            params = [name.trim(), role, await bcrypt.hash(password.trim(), 10), req.params.id];
            query = `UPDATE users SET name = $1, role = $2, password = $3 WHERE id = $4`;
        }
        await pool.query(query, params);
        res.json({ success: true });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// ЗАКАЗЫ
app.get('/api/orders', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM orders ORDER BY id DESC`);
        res.json(result.rows);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/orders/:id/status', authenticateToken, async (req, res) => {
    try {
        await pool.query(`UPDATE orders SET status = $1 WHERE id = $2`, [req.body.status, req.params.id]);
        res.json({ success: true });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/orders/:id', authenticateToken, async (req, res) => {
    const { product_type, client_name, deadline, details, amount, price, assignee } = req.body;
    const detailsStr = typeof details === 'object' ? JSON.stringify(details) : details;
    try {
        await pool.query(
            `UPDATE orders SET product_type=$1, client_name=$2, deadline=$3, details=$4, amount=$5, price=$6, assignee=$7 WHERE id=$8`,
            [product_type, client_name, deadline, detailsStr, parseInt(amount)||0, parseFloat(price)||0, assignee, req.params.id]
        );
        res.json({ success: true });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

const getPrefix = (type) => {
    const prefixes = { 'Книга':'BK', 'Визитка':'BC', 'Каталог':'CTLG', 'Буклет':'BLT', 'Ежедневник':'DRY', 'Блокнот':'NTP', 'Флаер':'FLR', 'Календарь настенный (3х секционный)':'CW3', 'Календарь настольный перекидной':'CDK', 'Календарь - домик':'CTN', 'Другое':'OTH' };
    return prefixes[type] || 'ORD';
};

app.post('/api/orders', authenticateToken, async (req, res) => {
    const { product_type, client_name, deadline, details, amount, price, assignee } = req.body;
    if (!product_type || !client_name || !assignee) return res.status(400).json({ error: 'Заполните обязательные поля' });
    
    const detailsStr = typeof details === 'object' ? JSON.stringify(details) : details;
    try {
        const result = await pool.query(
            `INSERT INTO orders (product_type, client_name, deadline, details, amount, price, creator_name, assignee) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [product_type, client_name, deadline, detailsStr, parseInt(amount)||0, parseFloat(price)||0, req.user.name, assignee]
        );
        const id = result.rows[0].id;
        const num = `${getPrefix(product_type)}-${String(id).padStart(4, '0')}/${new Date().getFullYear().toString().slice(-2)}`; 
        
        await pool.query(`UPDATE orders SET order_number = $1 WHERE id = $2`, [num, id]);
        
        // УВЕДОМЛЕНИЕ В ТЕЛЕГРАМ
        const userRes = await pool.query(`SELECT telegram_chat_id FROM users WHERE name = $1`, [assignee]);
        if (userRes.rows.length > 0 && userRes.rows[0].telegram_chat_id) {
            const dText = deadline && deadline !== 'Бессрочный' ? new Date(deadline).toLocaleDateString('ru-RU', {day: 'numeric', month: 'short', hour:'2-digit', minute:'2-digit'}) : 'Бессрочный';
            const msg = `📦 *Вам назначен новый заказ!*\n\n*Номер:* ${num}\n*Заказчик:* ${client_name}\n*Продукция:* ${product_type}\n*Тираж:* ${amount || 0} шт.\n*Дедлайн:* ${dText}\n\n👉 Зайдите в CRM для взятия в работу!`;
            bot.sendMessage(userRes.rows[0].telegram_chat_id, msg, {parse_mode: 'Markdown'});
        }

        res.json({ success: true, order_number: num });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.listen(port, '0.0.0.0', () => { console.log(`🚀 Сервер запущен. Порт: ${port}`); });
