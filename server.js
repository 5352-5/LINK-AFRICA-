import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const db = new Database(process.env.DB_FILE || path.join(__dirname, 'link-africa.db'));
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'dev-webhook-secret';
const COMMISSION_RATE = 0.15;

app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const one = (sql, ...p) => db.prepare(sql).get(...p);
const many = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

function auth(req, res, next) {
  const raw = req.headers.authorization || '';
  if (!raw.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
  try { req.user = jwt.verify(raw.slice(7), JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid or expired session' }); }
}
function token(u) { return jwt.sign({ id: u.id, role: u.role, name: u.name }, JWT_SECRET, { expiresIn: '7d' }); }
function publicUser(u) { return { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, verified: !!u.verified }; }
function isParticipant(order, uid) { return order && (order.buyer_id === uid || order.seller_id === uid); }

function seed() {
  const cats = ['Agriculture','Beauty & Fashion','Business','Construction','Education','Electronics','Food','Graphic Design','Home & Repair','Jobs & Freelancing','Photography & Video','Technology','Transport & Delivery','Other'];
  for (const c of cats) run('INSERT OR IGNORE INTO categories(name,type) VALUES(?,?)', c, 'both');
  if (one('SELECT COUNT(*) c FROM users').c === 0) {
    const hash = bcrypt.hashSync('ChangeMe123!', 10);
    const u = run('INSERT INTO users(name,email,phone,password_hash,role,verified) VALUES(?,?,?,?,?,1)', 'Demo Seller','seller@example.com','0700000000',hash,'seller');
    run('INSERT INTO seller_profiles(user_id,bio,location,payout_method,mpesa_phone) VALUES(?,?,?,?,?)', u.lastInsertRowid,'Verified Link Africa seller','Kenya','mpesa','0700000000');
    const cat = one('SELECT id FROM categories WHERE name=?', 'Graphic Design');
    run('INSERT INTO listings(seller_id,category_id,title,description,price,kind,stock,delivery_available) VALUES(?,?,?,?,?,?,?,?)', u.lastInsertRowid, cat.id, 'Logo & Brand Design', 'Professional logo and brand identity package.', 2500, 'service', 1, 0);
  }
}
seed();

app.get('/api/health', (req,res)=>res.json({ok:true,service:'Link Africa',environment:process.env.NODE_ENV||'development'}));
app.get('/api/categories', (req,res)=>res.json(many('SELECT * FROM categories ORDER BY name')));

app.post('/api/auth/register', async (req,res)=>{
  const {name,email,phone,password,role='buyer'} = req.body;
  if (!name || !password || (!email && !phone)) return res.status(400).json({error:'Name, password and email or phone are required'});
  if (!['buyer','seller'].includes(role)) return res.status(400).json({error:'Invalid role'});
  try {
    const hash = await bcrypt.hash(password, 12);
    const r = run('INSERT INTO users(name,email,phone,password_hash,role) VALUES(?,?,?,?,?)', name, email||null, phone||null, hash, role);
    if (role === 'seller') run('INSERT INTO seller_profiles(user_id,location,payout_method) VALUES(?,?,?)', r.lastInsertRowid,'Kenya','mpesa');
    const u = one('SELECT * FROM users WHERE id=?', r.lastInsertRowid);
    res.json({user:publicUser(u), token:token(u)});
  } catch { res.status(409).json({error:'Email or phone already registered'}); }
});

app.post('/api/auth/login', async (req,res)=>{
  const {email,phone,password} = req.body;
  const field = email ? 'email' : 'phone';
  const u = one(`SELECT * FROM users WHERE ${field}=?`, email || phone);
  if (!u || !(await bcrypt.compare(password || '', u.password_hash))) return res.status(401).json({error:'Invalid credentials'});
  res.json({user:publicUser(u), token:token(u)});
});
app.get('/api/me', auth, (req,res)=>res.json(publicUser(one('SELECT * FROM users WHERE id=?', req.user.id))));

app.get('/api/listings', (req,res)=>{
  const {q:term,kind,category} = req.query;
  let sql = `SELECT l.*,u.name seller,u.verified,c.name category FROM listings l JOIN users u ON u.id=l.seller_id LEFT JOIN categories c ON c.id=l.category_id WHERE l.status='active'`;
  const p=[];
  if(term){sql+=' AND (l.title LIKE ? OR l.description LIKE ?)';p.push('%'+term+'%','%'+term+'%');}
  if(kind){sql+=' AND l.kind=?';p.push(kind);}
  if(category){sql+=' AND c.name=?';p.push(category);}
  res.json(many(sql+' ORDER BY l.created_at DESC',...p));
});
app.post('/api/listings', auth, (req,res)=>{
  if(req.user.role!=='seller') return res.status(403).json({error:'Seller account required'});
  const {title,description,price,kind,category_id,stock=1,delivery_available=0} = req.body;
  if(!title||!description||!Number.isFinite(Number(price))||Number(price)<=0||!['goods','service'].includes(kind)) return res.status(400).json({error:'Invalid listing fields'});
  const r=run('INSERT INTO listings(seller_id,category_id,title,description,price,kind,stock,delivery_available) VALUES(?,?,?,?,?,?,?,?)',req.user.id,category_id||null,title,description,Math.round(Number(price)),kind,Math.max(1,Number(stock)),delivery_available?1:0);
  res.json(one('SELECT * FROM listings WHERE id=?',r.lastInsertRowid));
});

app.get('/api/sellers/:id',(req,res)=>{
  const u=one("SELECT id,name,email,phone,verified,created_at FROM users WHERE id=? AND role='seller'",req.params.id);
  if(!u) return res.status(404).json({error:'Seller not found'});
  res.json({...u,verified:!!u.verified,profile:one('SELECT * FROM seller_profiles WHERE user_id=?',u.id),listings:many("SELECT * FROM listings WHERE seller_id=? AND status='active'",u.id)});
});

app.post('/api/orders',auth,(req,res)=>{
  const {listing_id,payment_method,buyer_note=''}=req.body;
  if(!['mpesa','airtel','card','bank'].includes(payment_method)) return res.status(400).json({error:'Unsupported payment method'});
  const l=one("SELECT * FROM listings WHERE id=? AND status='active'",listing_id);
  if(!l) return res.status(404).json({error:'Listing not found'});
  if(req.user.id===l.seller_id) return res.status(400).json({error:'Cannot order your own listing'});
  const commission=Math.round(l.price*COMMISSION_RATE), payout=l.price-commission;
  const r=run(`INSERT INTO orders(buyer_id,seller_id,listing_id,amount,commission,payout_amount,payment_method,status,delivery_status,buyer_note)
               VALUES(?,?,?,?,?,?,?,?,?,?)`,req.user.id,l.seller_id,l.id,l.price,commission,payout,payment_method,'awaiting_payment',l.delivery_available?'pending':'not_required',buyer_note);
  res.json(one('SELECT * FROM orders WHERE id=?',r.lastInsertRowid));
});

async function startMpesaStk(order, phone) {
  if (!process.env.MPESA_CONSUMER_KEY || !process.env.MPESA_CONSUMER_SECRET || !process.env.MPESA_SHORTCODE || !process.env.MPESA_PASSKEY || !process.env.MPESA_CALLBACK_URL) {
    return {mode:'setup_required', message:'M-Pesa is not connected yet. Add the approved Daraja credentials and callback URL to the server environment.'};
  }
  // Integration boundary: credentials are read only from environment variables.
  // Implement the current Daraja OAuth + M-Pesa Express request here and persist CheckoutRequestID.
  return {mode:'provider_ready', message:'Daraja credentials detected. Complete the provider request adapter and webhook verification before enabling live money movement.'};
}

app.post('/api/orders/:id/pay',auth,async(req,res)=>{
  const o=one('SELECT * FROM orders WHERE id=?',req.params.id);
  if(!o||o.buyer_id!==req.user.id) return res.status(404).json({error:'Order not found'});
  if(o.status!=='awaiting_payment') return res.status(400).json({error:'Order is not awaiting payment'});
  const provider=(req.body.provider||o.payment_method).toLowerCase();
  const reference=`LA-${o.id}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  run('INSERT INTO transactions(order_id,provider,provider_ref,status,amount) VALUES(?,?,?,?,?)',o.id,provider,reference,'pending',o.amount);
  let result={mode:'sandbox_placeholder',reference,status:'pending',message:'Payment adapter is in setup mode. No real money has moved.'};
  if(provider==='mpesa') result=await startMpesaStk(o,req.body.phone||one('SELECT phone FROM users WHERE id=?',req.user.id)?.phone);
  res.json({...result,reference});
});

app.post('/api/webhooks/payment', (req,res)=>{
  const supplied=req.headers['x-link-africa-webhook-secret'];
  if(!supplied || supplied!==WEBHOOK_SECRET) return res.status(401).json({error:'Webhook authentication failed'});
  const {reference,status,provider_ref}=req.body;
  const t=one('SELECT * FROM transactions WHERE provider_ref=?',reference);
  if(!t) return res.status(404).json({error:'Transaction not found'});
  if(t.status==='paid') return res.json({ok:true,idempotent:true});
  if(!['paid','failed','cancelled'].includes(status)) return res.status(400).json({error:'Invalid status'});
  run('UPDATE transactions SET status=?,provider_ref=? WHERE id=?',status,provider_ref||t.provider_ref,t.id);
  if(status==='paid') run("UPDATE orders SET status='paid',payment_ref=? WHERE id=? AND status='awaiting_payment'",provider_ref||reference,t.order_id);
  else run("UPDATE orders SET status='payment_failed' WHERE id=? AND status='awaiting_payment'",t.order_id);
  res.json({ok:true});
});

app.get('/api/orders',auth,(req,res)=>res.json(many(`SELECT o.*,l.title listing_title,bu.name buyer,su.name seller FROM orders o JOIN listings l ON l.id=o.listing_id JOIN users bu ON bu.id=o.buyer_id JOIN users su ON su.id=o.seller_id WHERE o.buyer_id=? OR o.seller_id=? ORDER BY o.created_at DESC`,req.user.id,req.user.id)));
app.get('/api/orders/:id',auth,(req,res)=>{const o=one('SELECT * FROM orders WHERE id=?',req.params.id);if(!isParticipant(o,req.user.id))return res.status(404).json({error:'Order not found'});res.json(o);});

app.post('/api/orders/:id/complete',auth,(req,res)=>{
  const o=one('SELECT * FROM orders WHERE id=?',req.params.id);
  if(!o||o.seller_id!==req.user.id)return res.status(403).json({error:'Only seller can mark completed'});
  if(o.status!=='paid')return res.status(400).json({error:'Order must be paid before completion'});
  run("UPDATE orders SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=?",o.id);
  res.json(one('SELECT * FROM orders WHERE id=?',o.id));
});
app.post('/api/orders/:id/approve',auth,(req,res)=>{
  const o=one('SELECT * FROM orders WHERE id=?',req.params.id);
  if(!o||o.buyer_id!==req.user.id)return res.status(403).json({error:'Only buyer can approve'});
  if(o.status!=='completed')return res.status(400).json({error:'Seller must complete order first'});
  run("UPDATE orders SET status='approved',approved_at=CURRENT_TIMESTAMP WHERE id=?",o.id);
  run("INSERT INTO payouts(order_id,seller_id,amount,method) SELECT id,seller_id,payout_amount,CASE WHEN payment_method='bank' THEN 'bank' ELSE 'mpesa' END FROM orders WHERE id=? AND NOT EXISTS (SELECT 1 FROM payouts WHERE order_id=?)",o.id,o.id);
  res.json(one('SELECT * FROM orders WHERE id=?',o.id));
});
app.post('/api/orders/:id/dispute',auth,(req,res)=>{
  const o=one('SELECT * FROM orders WHERE id=?',req.params.id);
  if(!isParticipant(o,req.user.id))return res.status(403).json({error:'Not an order participant'});
  const r=run('INSERT INTO disputes(order_id,opened_by,reason) VALUES(?,?,?)',o.id,req.user.id,req.body.reason||'Order dispute');
  run("UPDATE orders SET status='disputed' WHERE id=? AND status NOT IN ('approved','refunded')",o.id);
  res.json(one('SELECT * FROM disputes WHERE id=?',r.lastInsertRowid));
});

app.get('/api/orders/:id/messages',auth,(req,res)=>{
  const o=one('SELECT * FROM orders WHERE id=?',req.params.id);
  if(!isParticipant(o,req.user.id))return res.status(404).json({error:'Order not found'});
  res.json(many('SELECT m.id,m.order_id,m.sender_id,m.body,m.created_at,u.name sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.order_id=? ORDER BY m.created_at ASC',o.id));
});
app.post('/api/orders/:id/messages',auth,(req,res)=>{
  const o=one('SELECT * FROM orders WHERE id=?',req.params.id);
  if(!isParticipant(o,req.user.id))return res.status(404).json({error:'Order not found'});
  const body=String(req.body.body||'').trim();
  if(!body||body.length>2000)return res.status(400).json({error:'Message must be 1–2000 characters'});
  const r=run('INSERT INTO messages(order_id,sender_id,body) VALUES(?,?,?)',o.id,req.user.id,body);
  res.json(one('SELECT m.id,m.order_id,m.sender_id,m.body,m.created_at,u.name sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?',r.lastInsertRowid));
});

app.get('/api/admin/summary',auth,(req,res)=>{
  if(req.user.role!=='admin')return res.status(403).json({error:'Admin only'});
  res.json({users:one('SELECT COUNT(*) c FROM users').c,sellers:one("SELECT COUNT(*) c FROM users WHERE role='seller'").c,listings:one('SELECT COUNT(*) c FROM listings').c,orders:one('SELECT COUNT(*) c FROM orders').c,gross:one("SELECT COALESCE(SUM(amount),0) total FROM orders WHERE status IN ('approved','completed')").total,commission:one("SELECT COALESCE(SUM(commission),0) total FROM orders WHERE status IN ('approved','completed')").total,disputes:one("SELECT COUNT(*) c FROM disputes WHERE status='open'").c});
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
server.listen(PORT,()=>console.log(`Link Africa running on http://localhost:${PORT}`));
