import { useState } from 'react';
import styles from './banner.module.css';

export default function Banner() {
  const [shown] = useState(true);
  return shown ? <p className={styles.banner}>banner from the fixture</p> : null;
}
