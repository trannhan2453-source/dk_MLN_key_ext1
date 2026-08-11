const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.json());

const upload = multer({ dest: 'uploads/' });

// Lưu danh sách thiết bị và tiến trình nạp
const devices = {}; // { device_id: { ws, data, flashProgress, avrProgress } }

// 1. API GIỮ NGUYÊN CHO ESP8266 HTTP SYNC CỦA BẠN
app.post('/api/esp-sync', (req, res) => {
  const { device_id, type, d1, d2, d3, d4, d5, d6, tag, value } = req.body;

  if (!devices[device_id]) {
    devices[device_id] = { flashProgress: 0, avrProgress: 0 };
  }
  devices[device_id].lastSeen = Date.now();
  devices[device_id].data = req.body;

  // Phản hồi mẫu lại cho ESP8266 (Bạn điều chỉnh theo logic database thực tế của bạn)
  res.json({
    status: 'ok',
    co_kiem: 0,
    co_axit: 0,
    co_tinhkhiet: 0,
    co_onoff: 0,
    co_volume: 0
  });
});

// 2. API LẤY DANH SÁCH THIẾT BỊ CHO APP
app.get('/api/devices', (req, res) => {
  const result = Object.keys(devices).map(id => ({
    id: id,
    online: (Date.now() - (devices[id].lastSeen || 0)) < 10000,
    flashProgress: devices[id].flashProgress || 0,
    avrProgress: devices[id].avrProgress || 0,
    data: devices[id].data || {}
  }));
  res.json({ devices: result });
});

// 3. API NHẬN FILE .BIN TỪ APP VÀ NẠP OTA DOWN ESP8266
app.post('/upload', upload.single('binFile'), (req, res) => {
  const file = req.file;
  let targetDevices = req.body.targetDevices;

  if (!file) return res.status(400).json({ error: 'Chưa chọn file .bin!' });

  if (typeof targetDevices === 'string') {
    try { targetDevices = JSON.parse(targetDevices); } catch (e) {}
  }

  if (!Array.isArray(targetDevices)) targetDevices = [targetDevices];

  const fileBuffer = fs.readFileSync(file.path);

  targetDevices.forEach(devId => {
    const dev = devices[devId];
    if (dev && dev.ws && dev.ws.readyState === WebSocket.OPEN) {
      dev.flashProgress = 0;
      dev.avrProgress = 0;

      // Bước 1: Gửi lệnh bắt đầu nhận file
      dev.ws.send('START_FLASH_FLASH');

      // Bước 2: Chia nhỏ file thành các gói 1024 bytes và gửi
      const CHUNK_SIZE = 1024;
      for (let offset = 0; offset < fileBuffer.length; offset += CHUNK_SIZE) {
        const chunk = fileBuffer.slice(offset, offset + CHUNK_SIZE);
        dev.ws.send(chunk);
      }

      // Bước 3: Báo hoàn tất truyền file
      dev.ws.send('END_FLASH_FLASH');
    }
  });

  fs.unlinkSync(file.path); // Xóa file tạm trên Server
  res.json({ message: 'Đã kích hoạt tiến trình nạp OTA thành công!' });
});

// 4. QUẢN LÝ KẾT NỐI WEBSOCKET TỪ ESP8266
wss.on('connection', (ws) => {
  let currentDeviceId = null;

  ws.on('message', (message) => {
    const msgStr = message.toString();

    if (msgStr.startsWith('REGISTER_DEVICE:')) {
      currentDeviceId = msgStr.split(':')[1];
      if (!devices[currentDeviceId]) devices[currentDeviceId] = {};
      devices[currentDeviceId].ws = ws;
      console.log(`[WS] Thiết bị kết nối thành công: ${currentDeviceId}`);
    } else if (msgStr.startsWith('PROGRESS_AVR:')) {
      const val = msgStr.split(':')[1];
      if (devices[currentDeviceId]) {
        devices[currentDeviceId].avrProgress = parseInt(val) || 100;
      }
    }
  });

  ws.on('close', () => {
    if (currentDeviceId && devices[currentDeviceId]) {
      devices[currentDeviceId].ws = null;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server đang chạy tại cổng ${PORT}`);
});
