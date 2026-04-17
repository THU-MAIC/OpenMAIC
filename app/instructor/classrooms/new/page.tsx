import { redirect } from 'next/navigation';

export default function NewClassroomIndexPage() {
  redirect('/instructor/classrooms/new/step/basics');
}
