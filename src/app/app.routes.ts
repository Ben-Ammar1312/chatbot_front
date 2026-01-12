import { Routes } from '@angular/router';
import {ChatPage} from './pages/chat.page';

export const routes: Routes = [
  {path: '', pathMatch: 'full',redirectTo: 'chat'},
  {path:'chat',component:ChatPage},
];
