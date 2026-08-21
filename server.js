const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cấu hình thư mục lưu trữ file .bin
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const deviceId = req.body.device_id || 'unknown';
        cb(null, `${deviceId}.bin`);
    }
});
const upload = multer({ storage: storage });

const ALLOWED_DEVICES = {
    "ML1": "123456",
    "ML2": "123",
    "ML3": "456"
};

const ONLINE_TIMEOUT = 30000; 
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
                d1: "N/A", d2: "N/A", d3: "N/A", d4: "N/A", d5: "N/A", d6: "N/A", d7: "N/A", d8: "N/A", d9: "N/A", d10: "N/A", d11: "N/A", d12: "N/A", d13: "N/A", d14: "N/A", d15: "N/A",         
                tag: "", value: ""
            },
            commands: {
                co_kiem: 0,
                co_axit: 0,
                co_tinhkhiet: 0,
                co_onoff: 0,
                co_volume: 0,
                co_update: 0
            },
            settings: {},
            ackStatus: "", // Bổ sung biến cờ lưu trạng thái phản hồi (VD: CAPNHATOK, update fail,...)
            lastSeen: 0
        };
    }
    return devices[deviceId];
}

// ==========================================
// --- API DÀNH CHO APP INVENTOR ---
// ==========================================

// API Nạp Firmware từ App Inventor (File .bin)
app.post('/api/upload-firmware', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
    const { device_id, secret_key } = req.query;

    console.log(`[OTA] Nhận yêu cầu nạp từ Device: ${device_id}`);

    if (!device_id || !ALLOWED_DEVICES[device_id]) {
        return res.status(404).json({ status: "ERROR", message: "Thiết bị không tồn tại!" });
    }

    if (!secret_key || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Mã PIN không chính xác!" });
    }

    if (!req.body || req.body.length === 0) {
        return res.status(400).json({ status: "ERROR", message: "File .bin rỗng hoặc không hợp lệ!" });
    }

    const filePath = path.join(uploadsDir, `${device_id}.bin`);
    fs.writeFile(filePath, req.body, (err) => {
        if (err) {
            console.error("Lỗi ghi file:", err);
            return res.status(500).json({ status: "ERROR", message: "Lỗi ghi file trên Server!" });
        }

        const device = getOrCreateDevice(device_id);
        device.commands.co_update = 1;

        console.log(`[OTA] File .bin đã lưu thành công! Đã bật cờ co_update=1`);
        return res.status(200).json({ 
            status: "OK", 
            message: "Đã tải file thành công lên Server!" 
        });
    });
});

app.post('/api/check-device', (req, res) => {
    const { device_id, secret_key } = req.body;
    if (!device_id || !secret_key) return res.status(400).json({ status: "ERROR", message: "Thiếu thông tin" });
    if (!ALLOWED_DEVICES.hasOwnProperty(device_id)) return res.json({ status: "ERROR", exists: false, online: false });
    if (ALLOWED_DEVICES[device_id] !== secret_key) return res.json({ status: "ERROR", exists: true, validKey: false });
    
    const onlineStatus = isOnline(device_id);
    return res.json({ status: "OK", exists: true, validKey: true, online: onlineStatus });
});

// API Lấy dữ liệu cho App Inventor (Đã tích hợp cờ ackStatus)
app.get('/api/getdata', (req, res) => {
    const { device_id, secret_key } = req.query;
    if (!device_id || !ALLOWED_DEVICES[device_id] || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Xác thực thất bại" });
    }
    const device = getOrCreateDevice(device_id);

    // Chuẩn bị dữ liệu phản hồi bao gồm dữ liệu thiết bị và cờ ACK
    const responseData = {
        ...device.data,
        ack: device.ackStatus, // Trả cờ ack về cho App Inventor
        online: isOnline(device_id)
    };

    // QUAN TRỌNG: Xóa cờ ACK ngay sau khi gửi để App không bị nhận lặp lại ở lần quét sau
    device.ackStatus = "";

    res.json(responseData);
});

app.post('/api/control', (req, res) => {
    const { device_id, secret_key, cmd } = req.body;
    if (!device_id || !ALLOWED_DEVICES[device_id] || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Xác thực thất bại" });
    }
    const device = getOrCreateDevice(device_id);
    if (cmd && device.commands.hasOwnProperty(`co_${cmd}`)) {
        device.commands[`co_${cmd}`] = 1;
        return res.json({ status: "OK", message: `Đã ghi nhận lệnh ${cmd}` });
    }
    res.status(400).json({ status: "ERROR", message: "Lệnh không hợp lệ" });
});

app.post('/api/set-settings', (req, res) => {
    const { device_id, secret_key, config_str } = req.body;

    if (!device_id || !ALLOWED_DEVICES[device_id] || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Xác thực thất bại" });
    }

    if (!config_str || typeof config_str !== 'string') {
        return res.status(400).json({ status: "ERROR", message: "Dữ liệu chuỗi không hợp lệ" });
    }

    const device = getOrCreateDevice(device_id);

    const parsedSettings = {};
    config_str.split(',').forEach(pair => {
        const [key, value] = pair.split(':');
        if (key && value !== undefined) {
            parsedSettings[key.trim()] = value.trim();
        }
    });

    device.settings = parsedSettings;

    return res.json({
        status: "OK",
        message: "Lưu cài đặt thành công",
        settings: device.settings
    });
});

// ==========================================
// --- API DÀNH CHO ESP8266 ---
// ==========================================

app.get('/api/download-firmware/:device_id', (req, res) => {
    const { device_id } = req.params;
    const filePath = path.join(uploadsDir, `${device_id}.bin`);

    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ status: "ERROR", message: "File firmware không tồn tại" });
    }
});

app.post('/api/esp-sync', (req, res) => {
    const { device_id, secret_key, type } = req.body;

    if (!device_id || !ALLOWED_DEVICES.hasOwnProperty(device_id) || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(401).json({ status: "ERROR", message: "Xác thực không hợp lệ" });
    }

    const device = getOrCreateDevice(device_id);
    device.lastSeen = Date.now();

    if (type) {
        if (type === "MULTI") {
            if (req.body.d1 && !req.body.d1.includes(':')) {
                device.data = {
                    type: type,
                    d1: req.body.d1, d2: req.body.d2,
                    d3: req.body.d3, d4: req.body.d4,
                    d5: req.body.d5, d6: req.body.d6,
                    d7: req.body.d7, d8: req.body.d8,
                    d9: req.body.d9, d10: req.body.d10,
                    d11: req.body.d11, d12: req.body.d12,
                    d13: req.body.d13, d14: req.body.d14,
                    d15: req.body.d15
                };
            }
        } else if (type === "SINGLE") {
            // Kiểm tra nếu là thông báo xác nhận từ ATmega2560
            if (req.body.tag === "CAPNHATOK") {
                device.ackStatus = "CAPNHATOK"; // Chốt cờ ackStatus riêng
            } else {
                device.data = {
                    type: type,
                    tag: req.body.tag || "",
                    value: req.body.value || ""
                };
            }
        } else if (type === "OTA_RESULT") {
            // Nhận kết quả OTA từ ESP8266
            device.ackStatus = req.body.tag || "OTA_FINISHED";
        }
    }

    // Trả commands và settings về cho ESP8266
    res.json({
        commands: device.commands,
        settings: device.settings
    });

    // Reset cờ lệnh sau khi gửi
    for (let key in device.commands) {
        device.commands[key] = 0;
    }
    // Xóa cài đặt sau khi gửi
    device.settings = {};
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
