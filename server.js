const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mqtt = require('mqtt'); // Bổ sung thư viện MQTT

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- CẤU HÌNH MQTT BROKER (Phải trùng với ESP8266) ---
const MQTT_BROKER = "mqtt://broker.emqx.io:1883"; // Hoặc server MQTT riêng
const mqttClient = mqtt.connect(MQTT_BROKER);

mqttClient.on('connect', () => {
    console.log('[MQTT] Kết nối thành công tới MQTT Broker!');
    // Đăng ký nhận dữ liệu từ TẤT CẢ các thiết bị dạng device/+/data và device/+/ota_result
    mqttClient.subscribe('device/+/data');
    mqttClient.subscribe('device/+/ota_result');
});

// Cấu hình thư mục lưu trữ file .bin
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

const ALLOWED_DEVICES = {
    "ML1": "123456",
    "ML2": "123",
    "ML3": "456"
};

const ONLINE_TIMEOUT = 45000; // Tăng lên 45s vì heartbeat ESP8266 là 30s
const devices = {};

function isOnline(deviceId) {
    if (!devices[deviceId] || !devices[deviceId].lastSeen) return false;
    return (Date.now() - devices[deviceId].lastSeen) < ONLINE_TIMEOUT;
}

function getOrCreateDevice(deviceId) {
    if (!devices[deviceId]) {
        devices[deviceId] = {
            secretKey: ALLOWED_DEVICES[deviceId] || "",
            data: {
                type: "NONE",
                d1: "N/A", d2: "N/A", d3: "N/A", d4: "N/A", d5: "N/A", d6: "N/A", d7: "N/A", d8: "N/A", d9: "N/A", d10: "N/A", d11: "N/A", d12: "N/A", d13: "N/A", d14: "N/A", d15: "N/A", d16: "N/A", d17: "N/A", d18: "N/A", d19: "N/A", d20: "N/A",         
                tag: "", value: ""
            },
            ackStatus: "",
            lastSeen: 0
        };
    }
    return devices[deviceId];
}

// ==========================================
// --- XỬ LÝ LẮNG NGHE DỮ LIỆU TỪ MQTT BROKER ---
// ==========================================
mqttClient.on('message', (topic, message) => {
    try {
        const topicParts = topic.split('/');
        const deviceId = topicParts[1];
        const messageType = topicParts[2]; // 'data' hoặc 'ota_result'

        if (!ALLOWED_DEVICES[deviceId]) return;

        const payload = JSON.parse(message.toString());
        const device = getOrCreateDevice(deviceId);
        device.lastSeen = Date.now();

        if (messageType === 'data') {
            if (payload.type === "MULTI") {
                device.data = {
                    type: payload.type,
                    d1: payload.d1, d2: payload.d2, d3: payload.d3, d4: payload.d4,
                    d5: payload.d5, d6: payload.d6, d7: payload.d7, d8: payload.d8,
                    d9: payload.d9, d10: payload.d10, d11: payload.d11, d12: payload.d12,
                    d13: payload.d13, d14: payload.d14, d15: payload.d15, d16: payload.d16,
                    d17: payload.d17, d18: payload.d18, d19: payload.d19, d20: payload.d20
                };
            } else if (payload.type === "SINGLE") {
                if (payload.tag === "CAPNHATOK") {
                    device.ackStatus = "CAPNHATOK";
                } else {
                    device.data = {
                        type: payload.type,
                        tag: payload.tag || "",
                        value: payload.value || ""
                    };
                }
            }
        } else if (messageType === 'ota_result') {
            device.ackStatus = payload.tag || "OTA_FINISHED";
        }
    } catch (err) {
        console.error("[MQTT Error] Lỗi parse JSON từ MQTT:", err.message);
    }
});

// ==========================================
// --- API DÀNH CHO APP INVENTOR ---
// ==========================================

// API Nạp Firmware từ App Inventor (File .bin)
app.post('/api/upload-firmware', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
    const { device_id, secret_key } = req.query;

    if (!device_id || !ALLOWED_DEVICES[device_id] || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Xác thực không hợp lệ!" });
    }

    if (!req.body || req.body.length === 0) {
        return res.status(400).json({ status: "ERROR", message: "File .bin rỗng!" });
    }

    const filePath = path.join(uploadsDir, `${device_id}.bin`);
    fs.writeFile(filePath, req.body, (err) => {
        if (err) {
            return res.status(500).json({ status: "ERROR", message: "Lỗi ghi file Server!" });
        }

        // Bắn cờ co_update = 1 trực tiếp qua MQTT để ESP8266 kích hoạt OTA ngay lập tức
        const commandTopic = `device/${device_id}/command`;
        const cmdPayload = JSON.stringify({ commands: { co_update: 1 } });
        
        mqttClient.publish(commandTopic, cmdPayload);
        console.log(`[OTA] Đã lưu .bin & Bắn MQTT co_update=1 tới device: ${device_id}`);

        return res.status(200).json({ status: "OK", message: "Tải file thành công, đang gửi lệnh nạp code!" });
    });
});

app.post('/api/check-device', (req, res) => {
    const { device_id, secret_key } = req.body;
    if (!device_id || !secret_key) return res.status(400).json({ status: "ERROR", message: "Thiếu thông tin" });
    if (!ALLOWED_DEVICES.hasOwnProperty(device_id)) return res.json({ status: "ERROR", exists: false, online: false });
    if (ALLOWED_DEVICES[device_id] !== secret_key) return res.json({ status: "ERROR", exists: true, validKey: false });
    
    return res.json({ status: "OK", exists: true, validKey: true, online: isOnline(device_id) });
});

// API Lấy dữ liệu cho App Inventor
app.get('/api/getdata', (req, res) => {
    const { device_id, secret_key } = req.query;
    if (!device_id || !ALLOWED_DEVICES[device_id] || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Xác thực thất bại" });
    }
    const device = getOrCreateDevice(device_id);

    const responseData = {
        ...device.data,
        ack: device.ackStatus,
        online: isOnline(device_id)
    };

    device.ackStatus = ""; // Clear ack ngay sau khi app đọc
    res.json(responseData);
});

// API Gửi lệnh điều khiển từ App Inventor -> Đẩy thẳng qua MQTT
app.post('/api/control', (req, res) => {
    const { device_id, secret_key, cmd } = req.body;
    if (!device_id || !ALLOWED_DEVICES[device_id] || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Xác thực thất bại" });
    }

    if (cmd) {
        const commandTopic = `device/${device_id}/command`;
        const cmdObj = { commands: {} };
        cmdObj.commands[`co_${cmd}`] = 1;

        // Push trực tiếp xuống MQTT Broker (Realtime < 10ms)
        mqttClient.publish(commandTopic, JSON.stringify(cmdObj));
        return res.json({ status: "OK", message: `Đã gửi lệnh ${cmd} qua MQTT` });
    }
    res.status(400).json({ status: "ERROR", message: "Lệnh không hợp lệ" });
});

// API Gửi Cài đặt từ App Inventor -> Đẩy thẳng qua MQTT
app.post('/api/set-settings', (req, res) => {
    const { device_id, secret_key, config_str } = req.body;

    if (!device_id || !ALLOWED_DEVICES[device_id] || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Xác thực thất bại" });
    }

    if (!config_str || typeof config_str !== 'string') {
        return res.status(400).json({ status: "ERROR", message: "Dữ liệu chuỗi không hợp lệ" });
    }

    const parsedSettings = {};
    config_str.split(',').forEach(pair => {
        const [key, value] = pair.split(':');
        if (key && value !== undefined) {
            parsedSettings[key.trim()] = value.trim();
        }
    });

    const commandTopic = `device/${device_id}/command`;
    const payload = JSON.stringify({ settings: parsedSettings });

    // Push trực tiếp xuống MQTT Broker
    mqttClient.publish(commandTopic, payload);

    return res.json({
        status: "OK",
        message: "Đã gửi cài đặt qua MQTT thành công",
        settings: parsedSettings
    });
});

// API cho ESP8266 tải file Firmware .bin (Giữ nguyên)
app.get('/api/download-firmware/:device_id', (req, res) => {
    const { device_id } = req.params;
    const filePath = path.join(uploadsDir, `${device_id}.bin`);

    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ status: "ERROR", message: "File firmware không tồn tại" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server MQTT Proxy running on port ${PORT}`));
