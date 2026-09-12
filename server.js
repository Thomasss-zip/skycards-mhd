const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = 3000;

const GOLEMIO_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6NjExMCwiaWF0IjoxNzg5MjUwNTQ5LCJleHAiOjExNzg5MjUwNTQ5LCJpc3MiOiJnb2xlbWlvIiwianRpIjoiZDQwZDAxNzQtN2VmZS00M2M0LTg4NTMtYzNiMDE4MDgzMzc4In0.ev2UXTysLnDUmd6I9_2F15nwayenQ4t0nL_tt86ZuOQ';

const db = new sqlite3.Database('./skycards.db', (err) => {
  if (err) console.error('Chyba DB:', err.message);
  else console.log('📁 SQLite databáze připojena.');
});

// Vytvoření tabulky s kompletními sloupci
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS caught_cards (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    line TEXT,
    type TEXT,
    reg_number TEXT,
    destination TEXT,
    photo_url TEXT,
    caught_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

function getPhotoUrl(type, regNum, line) {
  const cleanReg = String(regNum).replace(/\D/g, ''); // Vyfiltruje pouze čísla

  if (type === 'Vlak') {
    return `https://www.google.com/search?tbm=isch&q=vlak+linka+${encodeURIComponent(line)}+${encodeURIComponent(regNum)}`;
  } else if (cleanReg) {
    // Přesný tvar URL z vyhledávače seznam-autobusu.cz s filtrem na provozní stav
    return `https://seznam-autobusu.cz/seznam?hasNumber=ano&operatorCountryId=1&evc=${cleanReg}&state=zar`;
  }
  return null;
}

app.get('/api/vehicles', async (req, res) => {
  try {
    const userLat = parseFloat(req.query.lat);
    const userLng = parseFloat(req.query.lng);
    const maxRadius = parseFloat(req.query.radius) || 100000;

    const response = await axios.get('https://api.golemio.cz/v2/vehiclepositions', {
      headers: { 'X-Access-Token': GOLEMIO_API_KEY, 'Content-Type': 'application/json' },
      params: { limit: 1000 }
    });

    const features = response.data.features || [];

    const processedVehicles = features.map((f, index) => {
      const coords = f.geometry ? f.geometry.coordinates : [0, 0];
      const props = f.properties || {};
      const trip = props.trip || {};
      const lastPos = props.last_position || {};
      
      const vLng = coords[0];
      const vLat = coords[1];

      const line = trip.gtfs?.route_short_name || trip.origin_route_name || trip.gtfs?.trip_short_name || '?';
      const delaySeconds = lastPos.delay?.actual !== undefined ? lastPos.delay.actual : 0;
      const delay = Math.round(delaySeconds / 60);

      // Určení typu vozidla
      let vehicleType = trip.vehicle_type?.description_cs || 'Vozidlo';
      if (line.startsWith('Os') || line.startsWith('R') || line.startsWith('Sp') || trip.gtfs?.route_type === 2) {
        vehicleType = 'Vlak';
      } else if (trip.gtfs?.route_type === 0 || vehicleType.toLowerCase().includes('tram')) {
        vehicleType = 'Tramvaj';
      } else if (trip.gtfs?.route_type === 1 || vehicleType.toLowerCase().includes('metro')) {
        vehicleType = 'Metro';
      } else if (trip.gtfs?.route_type === 3 || vehicleType.toLowerCase().includes('autobus')) {
        vehicleType = 'Autobus';
      }

      // Čistá hodnota evidenčního čísla bez zdvojování "Ev.č."
      const rawReg = trip.vehicle_registration_number;
      const regNum = rawReg ? `${rawReg}` : `Spoj ${trip.gtfs?.trip_id || index}`;
      const photoUrl = getPhotoUrl(vehicleType, regNum, line);

      let distance = null;
      if (!isNaN(userLat) && !isNaN(userLng) && vLat && vLng) {
        distance = calculateDistance(userLat, userLng, vLat, vLng);
      }

      return {
        id: `veh_${trip.gtfs?.trip_id || index}`,
        line: line,
        lat: vLat,
        lng: vLng,
        delay: delay,
        type: vehicleType,
        regNum: regNum,
        photoUrl: photoUrl,
        destination: trip.gtfs?.trip_headsign || 'Neznámý cíl',
        distanceMeters: distance,
        canCatch: distance !== null && distance <= 50000
      };
    })
    .filter(v => isNaN(userLat) || isNaN(userLng) || (v.distanceMeters !== null && v.distanceMeters <= maxRadius));

    res.json(processedVehicles);
  } catch (error) {
    console.error('Chyba Golemio API:', error.message);
    res.json([]);
  }
});

app.get('/api/cards/:userId', (req, res) => {
  db.all('SELECT * FROM caught_cards WHERE user_id = ? ORDER BY caught_at DESC', [req.params.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/cards', (req, res) => {
  const { id, userId, line, type, regNum, destination, photoUrl } = req.body;
  
  db.get('SELECT id FROM caught_cards WHERE user_id = ? AND reg_number = ?', [userId, regNum], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (row) {
      return res.status(400).json({ error: 'Tohle vozidlo už ve svém albu máš!' });
    }

    const sql = `INSERT INTO caught_cards (id, user_id, line, type, reg_number, destination, photo_url) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.run(sql, [id, userId, line, type, regNum, destination, photoUrl], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server běžící na http://localhost:3000`);
});