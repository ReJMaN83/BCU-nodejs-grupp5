// Temporary mock data for issue #16.
// Once the backend exposes GET /api/patients, this file can be deleted
// and PatientSearch.jsx should call api.get('/api/patients') instead.

export const mockPatients = [
  { id: 'p1', fullName: 'Anna Karlsson', personalId: '19850312-4521' },
  { id: 'p2', fullName: 'Erik Johansson', personalId: '19921107-8834' },
  { id: 'p3', fullName: 'Maria Lindqvist', personalId: '19760822-1190' },
  { id: 'p4', fullName: 'Johan Bergström', personalId: '19901215-6672' },
  { id: 'p5', fullName: 'Sara Nilsson', personalId: '19881030-3345' },
];