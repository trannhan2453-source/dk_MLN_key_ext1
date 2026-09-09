const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const net = require('net');
const aedes = require('aedes')();

// ==========================================
// 1. CẤU HÌNH CƠ SỞ DỮ LIỆU & THƯ MỤC
// ==========================================

const ALLOWED_DEVICES = {
    "ML1": "123456",
    "ML2": "123",
    "ML3": "456"
};

const ONLINE_TIMEOUT = 30000; // 30 giây không gửi MQTT coi như offline
const devices = {};

// Tự động tạo thư mục uploads nếu chưa có
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

function getOrCreateDevice(deviceId) {
    if (!devices[deviceId]) {
        devices[deviceId] = {
            secretKey: ALLOWED_DEVICES[deviceId] || "",
            data: {
                type: "NONE",
                d1: "N/A", d2: "N/A", d3: "N/A", d4: "N/A", d5: "N/A", 
                d6: "N/A", d7: "N/A", d8: "N/A", d9: "N/A", d10: "N/A", 
                d11: "N/A", d12: "N/A", d13: "N/A", d14: "N/A", d15: "N/A", 
                d16: "N/A", d17: "N/A", d18: "N/A", d19: "N/A", d20: "N/A",         
                tag: "", value: ""
            },
            settings: {},
            ackStatus: "",
            lastSeen: 0
        };
    }
    return devices[deviceId];
}

function isOnline(deviceId) {
    if (!devices[deviceId] || !devices[deviceId].lastSeen) return false;
    return (Date.now() - devices[deviceId].lastSeen) < ONLINE_TIMEOUT;
}

// ==========================================
// 2. KHỞI TẠO MQTT BROKER (CỔNG 1883)
// ==========================================

const mqttServer = net.createServer(aedes.handle);
const MQTT_PORT = 1883;

mqttServer.listen(MQTT_PORT, () => {
    console.log(`[MQTT Broker] Đang chạy tại cổng ${MQTT_PORT}`);
});

// Xử lý dữ liệu ESP8266 gửi lên Broker
aedes.on('publish', (packet, client) => {
    if (!client) return; // Bỏ qua message nội bộ từ Server

    const topic = packet.topic;
    const payloadStr = packet.payload.toString();

    // Định dạng Topic: devices/{device_id}/{data|ack}
    const topicParts = topic.split('/');
    if (topicParts[0] === 'devices' && topicParts[1]) {
        const deviceId = topicParts[1];
        const action = topicParts[2]; // 'data' hoặc 'ack'

        if (!ALLOWED_DEVICES.hasOwnProperty(deviceId)) return;

        const device = getOrCreateDevice(deviceId);
        device.lastSeen = Date.now();

        try {
            const payload = JSON.parse(payloadStr);

            if (action === 'data') {
                if (payload.type === "MULTI") {
                    device.data = { ...device.data, ...payload };
                } else {
                    device.data.type = payload.type || "SINGLE";
                    device.data.tag = payload.tag || "";
                    device.data.value = payload.value || "";
                }
            } else if (action === 'ack') {
                if (payload.tag === "CAPNHATOK" || payload.ack) {
                    device.ackStatus = payload.tag || payload.ack;
                }
            }
        } catch (err) {
            // Trường hợp payload gửi lên là chuỗi thô (PlainText)
            if (action === 'ack') {
                device.ackStatus = payloadStr;
            }
        }
    }
});

// ==========================================
// 3. KHỞI TẠO HTTP EXPRESS SERVER (CỔNG 3000)
// ==========================================

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- API CHO APP INVENTOR ---

// Check thiết bị online/tồn tại
app.post('/api/check-device', (req, res) => {
    const { device_id, secret_key } = req.body;
    if (!device_id || !secret_key) return res.status(400).json({ status: "ERROR", message: "Thiếu thông tin" });
    if (!ALLOWED_DEVICES.hasOwnProperty(device_id)) return res.json({ status: "ERROR", exists: false, online: false });
    if (ALLOWED_DEVICES[device_id] !== secret_key) return res.json({ status: "ERROR", exists: true, validKey: false });
    
    return res.json({ status: "OK", exists: true, validKey: true, online: isOnline(device_id) });
});

// Lấy dữ liệu cho App Inventor (Gồm data, status ACK và online)
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

    // Xóa cờ ACK sau khi App đã nhận
    device.ackStatus = "";

    return res.json(responseData);
});

// Điều khiển thiết bị -> Bắn trực tiếp qua MQTT ngay lập tức
app.post('/api/control', (req, res) => {
    const { device_id, secret_key, cmd } = req.body;
    if (!device_id || !ALLOWED_DEVICES[device_id] || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Xác thực thất bại" });
    }

    if (!cmd) return res.status(400).json({ status: "ERROR", message: "Thiếu lệnh" });

    // Bắn lệnh qua MQTT Broker xuống ESP8266
    aedes.publish({
        topic: `devices/${device_id}/cmd`,
        payload: JSON.stringify({ cmd: cmd })
    });

    console.log(`[CONTROL] Đã gửi lệnh '${cmd}' tới ${device_id} qua MQTT`);
    return res.json({ status: "OK", message: `Đã gửi lệnh ${cmd}` });
});

// Cài đặt thông số -> Bắn ngay qua MQTT
app.post('/api/set-settings', (req, res) => {
    const { device_id, secret_key, config_str } = req.body;
    if (!device_id || !ALLOWED_DEVICES[device_id] || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Xác thực thất bại" });
    }

    if (!config_str || typeof config_str !== 'string') {
        return res.status(400).json({ status: "ERROR", message: "Chuỗi cấu hình không hợp lệ" });
    }

    const parsedSettings = {};
    config_str.split(',').forEach(pair => {
        const [key, value] = pair.split(':');
        if (key && value !== undefined) {
            parsedSettings[key.trim()] = value.trim();
        }
    });

    // Bắn chuỗi cấu hình qua MQTT
    aedes.publish({
        topic: `devices/${device_id}/settings`,
        payload: JSON.stringify(parsedSettings)
    });

    return res.json({
        status: "OK",
        message: "Đã gửi cài đặt thành công",
        settings: parsedSettings
    });
});

// Upload Firmware .bin từ App Inventor
app.post('/api/upload-firmware', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
    const { device_id, secret_key } = req.query;

    if (!device_id || !ALLOWED_DEVICES[device_id]) {
        return res.status(404).json({ status: "ERROR", message: "Thiết bị không tồn tại!" });
    }

    if (!secret_key || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Mã PIN không chính xác!" });
    }

    if (!req.body || req.body.length === 0) {
        return res.status(400).json({ status: "ERROR", message: "File .bin rỗng!" });
    }

    const filePath = path.join(uploadsDir, `${device_id}.bin`);
    fs.writeFile(filePath, req.body, (err) => {
        if (err) {
            console.error("Lỗi ghi file:", err);
            return res.status(500).json({ status: "ERROR", message: "Lỗi ghi file trên Server!" });
        }

        // Bắn cờ kích hoạt OTA qua MQTT
        aedes.publish({
            topic: `devices/${device_id}/cmd`,
            payload: JSON.stringify({ cmd: "update" })
        });

        console.log(`[OTA] Đã lưu file ${device_id}.bin và gửi lệnh update qua MQTT`);
        return res.status(200).json({ status: "OK", message: "Đã tải file lên Server thành công!" });
    });
});

// --- API DÀNH CHO ESP8266 TẢI FIRMWARE (OTA) ---

app.get('/api/download-firmware/:device_id', (req, res) => {
    const { device_id } = req.params;
    const filePath = path.join(uploadsDir, `${device_id}.bin`);

    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ status: "ERROR", message: "File firmware không tồn tại" });
    }
});

// ==========================================
// 4. CHẠY SERVER
// ==========================================

const HTTP_PORT = process.env.PORT || 3000;
app.listen(HTTP_PORT, () => {
    console.log(`[HTTP Server] Đang chạy tại cổng ${HTTP_PORT}`);
});
