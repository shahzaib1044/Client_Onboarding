// supabaseClient.js
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

export const supabase = createClient(
  process.env.SUPABASE_URL,          // your Supabase project URL
  process.env.SUPABASE_SERVICE_KEY   // your Supabase service key
);
