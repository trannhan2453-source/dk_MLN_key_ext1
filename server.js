const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const net = require('net');
const aedes = require('aedes')();
const mqtt = require('mqtt');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 1. KỞI TẠO MQTT BROKER (Cổng 1883)
// ==========================================
const MQTT_PORT = 1883;
const server = net.createServer(aedes.handle);

server.listen(MQTT_PORT, () => {
    console.log(`[MQTT Broker] Đang chạy trên cổng ${MQTT_PORT}`);
});

// Quản lý xác thực kết nối MQTT từ thiết bị
const ALLOWED_DEVICES = {
    "ML1": "123456",
    "ML2": "123",
    "ML3": "456"
};

aedes.authenticate = (client, username, password, callback) => {
    const deviceId = client.id;
    const pwd = password ? password.toString() : '';

    if (ALLOWED_DEVICES[deviceId] && ALLOWED_DEVICES[deviceId] === pwd) {
        return callback(null, true); // Xác thực thành công
    }
    const error = new Error('Xác thực MQTT thất bại');
    error.returnCode = 4;
    return callback(error, false);
};

// ==========================================
// 2. KẾT NỐI INTERNAL CLIENT ĐỂ LẮNG NGHE DATA
// ==========================================
const internalClient = mqtt.connect(`mqtt://localhost:${MQTT_PORT}`, {
    clientId: 'SERVER_INTERNAL_CLIENT'
});

// Lưu trữ tạm thời trạng thái thiết bị để phục vụ App Inventor
const devices = {};

function getOrCreateDevice(deviceId) {
    if (!devices[deviceId]) {
        devices[deviceId] = {
            data: { type: "NONE", tag: "", value: "" },
            ackStatus: "",
            online: false,
            lastSeen: 0
        };
    }
    return devices[deviceId];
}

internalClient.on('connect', () => {
    console.log('[Internal Client] Đã kết nối vào MQTT Broker nội bộ');
    // Subscribe tất cả topic dữ liệu và phản hồi từ ESP8266
    internalClient.subscribe('+/data');
    internalClient.subscribe('+/status');
});

internalClient.on('message', (topic, payload) => {
    const topicParts = topic.split('/');
    const deviceId = topicParts[0];
    const subTopic = topicParts[1];

    const device = getOrCreateDevice(deviceId);
    device.lastSeen = Date.now();
    device.online = true;

    try {
        const message = JSON.parse(payload.toString());

        if (subTopic === 'status') {
            device.online = (message.status === 'online');
            return;
        }

        if (subTopic === 'data') {
            if (message.tag === "CAPNHATOK") {
                device.ackStatus = "CAPNHATOK";
            } else {
                device.data = message;
            }
        }
    } catch (e) {
        console.error(`Lỗi parse JSON từ ${deviceId}:`, e.message);
    }
});

// ==========================================
// 3. API HTTP DÀNH CHO APP INVENTOR & OTA
// ==========================================

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// API Lấy dữ liệu cho App Inventor
app.get('/api/getdata', (req, res) => {
    const { device_id, secret_key } = req.query;
    if (!device_id || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Xác thực thất bại" });
    }

    const device = getOrCreateDevice(device_id);
    const responseData = {
        ...device.data,
        ack: device.ackStatus,
        online: device.online && (Date.now() - device.lastSeen < 30000)
    };

    device.ackStatus = ""; // Clear ACK flag sau khi App đọc
    res.json(responseData);
});

// API Điều khiển thiết bị từ App Inventor (Publish lệnh qua MQTT)
app.post('/api/control', (req, res) => {
    const { device_id, secret_key, cmd } = req.body;
    if (!device_id || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Xác thực thất bại" });
    }

    // Phát lệnh tức thì qua MQTT Topic
    const payload = JSON.stringify({ command: `co_${cmd}`, value: 1 });
    internalClient.publish(`${device_id}/commands`, payload);

    return res.json({ status: "OK", message: `Đã phát lệnh ${cmd} qua MQTT` });
});

// API Gửi cài đặt từ App Inventor
app.post('/api/set-settings', (req, res) => {
    const { device_id, secret_key, config_str } = req.body;
    if (!device_id || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Xác thực thất bại" });
    }

    const parsedSettings = {};
    config_str.split(',').forEach(pair => {
        const [key, value] = pair.split(':');
        if (key && value !== undefined) parsedSettings[key.trim()] = value.trim();
    });

    // Phát cài đặt tức thì xuống thiết bị
    internalClient.publish(`${device_id}/settings`, JSON.stringify(parsedSettings));

    return res.json({ status: "OK", message: "Đã phát cài đặt qua MQTT" });
});

// API Nạp Firmware (OTA)
app.post('/api/upload-firmware', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
    const { device_id, secret_key } = req.query;
    if (!device_id || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Xác thực thất bại" });
    }

    const filePath = path.join(uploadsDir, `${device_id}.bin`);
    fs.writeFile(filePath, req.body, (err) => {
        if (err) return res.status(500).json({ status: "ERROR", message: "Lỗi ghi file!" });

        // Báo cho ESP biết có bản cập nhật mới
        internalClient.publish(`${device_id}/commands`, JSON.stringify({ command: "co_update", value: 1 }));
        return res.json({ status: "OK", message: "Tải file thành công, đã phát lệnh OTA!" });
    });
});

app.get('/api/download-firmware/:device_id', (req, res) => {
    const filePath = path.join(uploadsDir, `${req.params.device_id}.bin`);
    if (fs.existsSync(filePath)) res.download(filePath);
    else res.status(404).json({ status: "ERROR", message: "File không tồn tại" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP API Server running on port ${PORT}`));
