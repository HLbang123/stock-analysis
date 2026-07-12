import { BrowserRouter, Routes, Route } from 'react-router-dom';
import AppLayout from './components/layout/AppLayout';
import HomePage from './pages/HomePage';
import StockPage from './pages/StockPage';
import WatchlistPage from './pages/WatchlistPage';

export default function App() {
  return (
    <BrowserRouter>
      <AppLayout>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/stock/:code" element={<StockPage />} />
          <Route path="/watchlist" element={<WatchlistPage />} />
        </Routes>
      </AppLayout>
    </BrowserRouter>
  );
}
