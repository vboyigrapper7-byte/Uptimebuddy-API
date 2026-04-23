exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.sql(`
        UPDATE users 
        SET tier = 'business', plan_id = 'business' 
        WHERE email = 'growthmantrasolutions@gmail.com';
    `);
};

exports.down = (pgm) => {
    // Reverting to free if needed, but usually manual grants aren't reverted via migration down
    pgm.sql(`
        UPDATE users 
        SET tier = 'free', plan_id = 'free' 
        WHERE email = 'growthmantrasolutions@gmail.com';
    `);
};
