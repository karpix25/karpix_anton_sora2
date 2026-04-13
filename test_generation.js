import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import path from 'path';

dotenv.config();

const KIE_API_KEY = process.env.KIE_AI_API_KEY;
const BASE_URL = 'https://api.kie.ai/api/v1';

const prompts = [
  {
    name: 'sora2',
    model: 'sora-2-pro-text-to-video',
    prompt: 'A high-end cinematic fashion video. A stylish woman stands in an elegant, sun-drenched historical villa hallway. She is holding a luxury gold watch. Soft lighting, premium aesthetic. 4k.'
  },
  {
    name: 'veo3',
    model: 'veo-3-1',
    prompt: 'Lifestyle commercial. A couple is interacting playfully in a modern luxury apartment. Camera pans to close-up on a designer perfume bottle. Warm sunlight, joyful mood. 4k.'
  }
];

async function generate(model, prompt, name) {
  console.log(`🚀 Starting generation for ${name}...`);
  try {
    const res = await axios.post(`${BASE_URL}/jobs/createTask`, {
      model: model,
      input: {
        prompt: prompt,
        // Using "portrait" which is the standard term for 9:16 in many AI video APIs
        aspect_ratio: "portrait" 
      }
    }, {
      headers: { 
        'Authorization': `Bearer ${KIE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const taskId = res.data.data?.taskId;
    if (!taskId) {
        console.error(`❌ No taskId for ${name}:`, JSON.stringify(res.data));
        return null;
    }
    console.log(`✅ Task for ${name}: ${taskId}`);
    return { taskId, name };
  } catch (e) {
    console.error(`❌ Error ${name}:`, e.response?.data || e.message);
    return null;
  }
}

async function poll(taskId, name) {
  console.log(`⏳ Polling ${name}...`);
  while (true) {
    try {
      const res = await axios.get(`${BASE_URL}/jobs/getTaskDetail`, {
        params: { taskId },
        headers: { 'Authorization': `Bearer ${KIE_API_KEY}` }
      });
      
      const task = res.data.data;
      if (!task) throw new Error("No data in response");

      const status = task.status;
      if (status === 'FINISHED' || status === 'COMPLETED' || status === 'succeeded') {
        return task.videoUrl || task.video_url;
      }
      if (status === 'FAILED') throw new Error(task.message || 'Task failed');
      
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, 20000));
    } catch (e) {
      console.error(`\n❌ Polling error ${name}:`, e.message);
      await new Promise(r => setTimeout(r, 20000));
    }
  }
}

async function run() {
  const tasks = [];
  for (const p of prompts) {
    const t = await generate(p.model, p.prompt, p.name);
    if (t) tasks.push(t);
  }

  if (tasks.length === 0) return;

  for (const t of tasks) {
    try {
        const url = await poll(t.taskId, t.name);
        console.log(`\n📥 Downloading ${t.name}...`);
        if (!fs.existsSync('test')) fs.mkdirSync('test');
        const writer = fs.createWriteStream(path.join('test', `${t.name}_result.mp4`));
        const res = await axios({ url, method: 'GET', responseType: 'stream' });
        res.data.pipe(writer);
        await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });
        console.log(`✅ Saved: ${t.name}_result.mp4`);
    } catch (err) {
        console.error(`\n❌ Error ${t.name}:`, err.message);
    }
  }
}

run();
