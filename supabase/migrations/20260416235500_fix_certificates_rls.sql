-- Fix UPSERT functionality by adding an UPDATE policy for certificates
DROP POLICY IF EXISTS "Users can update their own certificates" ON public.certificates;
CREATE POLICY "Users can update their own certificates" ON public.certificates 
FOR UPDATE USING (auth.uid() = user_id);
