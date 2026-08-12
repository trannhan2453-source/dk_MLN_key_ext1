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
                d1: "N/A", d2: "N/A", d3: "N/A", d4: "N/A", d5: "N/A", d6: "N/A",        
                tag: "", value: ""
            },
            commands: {
                co_kiem: 0,
                co_axit: 0,
                co_tinhkhiet: 0,
                co_onoff: 0,
                co_volume: 0,
                co_update: 0 // Cờ báo nạp code
            },
            // Lưu trạng thái tiến trình OTA
            otaStatus: {
                status: "NONE", // NONE, PROCESSING, SUCCESS, FAILED
                message: "Chưa có tiến trình nạp"
            },
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

    // Lưu file vào thư mục uploads
    const filePath = path.join(uploadsDir, `${device_id}.bin`);
    fs.writeFile(filePath, req.body, (err) => {
        if (err) {
            console.error("Lỗi ghi file:", err);
            return res.status(500).json({ status: "ERROR", message: "Lỗi ghi file trên Server!" });
        }

        // Bật cờ nạp OTA & Cập nhật trạng thái bắt đầu nạp
        const device = getOrCreateDevice(device_id);
        device.commands.co_update = 1;
        device.otaStatus = {
            status: "PROCESSING",
            message: "File đã tải lên Server, đang chờ ESP8266 thực hiện nạp..."
        };

        console.log(`[OTA] File .bin đã lưu thành công! Đã bật cờ co_update=1`);
        return res.status(200).json({ 
            status: "OK", 
            message: "Đã tải file lên Server thành công!" 
        });
    });
});

// API Kiểm tra trạng thái nạp code (Dành riêng cho App Inventor polling/gọi định kỳ)
app.get('/api/get-ota-status', (req, res) => {
    const { device_id, secret_key } = req.query;
    if (!device_id || !ALLOWED_DEVICES[device_id] || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Xác thực thất bại" });
    }
    const device = getOrCreateDevice(device_id);
    res.json({
        status: "OK",
        ota_status: device.otaStatus.status,
        ota_msg: device.otaStatus.message
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

app.get('/api/getdata', (req, res) => {
    const { device_id, secret_key } = req.query;
    if (!device_id || !ALLOWED_DEVICES[device_id] || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Xác thực thất bại" });
    }
    const device = getOrCreateDevice(device_id);
    res.json({ 
        ...device.data, 
        online: isOnline(device_id),
        ota_status: device.otaStatus.status,
        ota_msg: device.otaStatus.message
    });
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

// ==========================================
// --- API DÀNH CHO ESP8266 ---
// ==========================================

// Endpoint cho ESP8266 tải file .bin
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

    // XỬ LÝ BÁO CÁO KẾT QUẢ OTA TỪ ESP8266 (KHI ĐÃ NẠP XONG HOẶC LỖI)
    if (type === "OTA_STATUS") {
        device.otaStatus = {
            status: req.body.ota_status || "UNKNOWN",
            message: req.body.ota_msg || ""
        };
        device.commands.co_update = 0; // Đảm bảo hạ cờ update
        console.log(`[OTA FINISH] Device: ${device_id} | Status: ${req.body.ota_status} | Msg: ${req.body.ota_msg}`);
        return res.json({ status: "OK" });
    }

    // Xử lý sync dữ liệu cảm biến / hiển thị
    if (type) {
        if (type === "MULTI") {
            if (req.body.d1 && !req.body.d1.includes(':')) {
                device.data = {
                    type: type,
                    d1: req.body.d1, d2: req.body.d2,
                    d3: req.body.d3, d4: req.body.d4,
                    d5: req.body.d5, d6: req.body.d6
                };
            }
        } else if (type === "SINGLE") {
            device.data = {
                type: type,
                tag: req.body.tag || "",
                value: req.body.value || ""
            };
        }
    }

    // Trả lệnh cờ về cho ESP
    res.json(device.commands);

    // Reset cờ lệnh điều khiển sau khi gửi
    for (let key in device.commands) {
        device.commands[key] = 0;
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
